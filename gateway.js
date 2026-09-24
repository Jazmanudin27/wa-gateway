import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys';
import { EventEmitter } from 'events';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import QRCode from 'qrcode';
import axios from 'axios';
import { fileURLToPath } from 'url';
import dns from 'dns';
import { insertMessage, updateMessageStatus } from './db.js';

// Fix for Node.js 17+ DNS resolution issues on Windows/specific ISPs
dns.setDefaultResultOrder('ipv4first');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class WhatsAppGateway extends EventEmitter {
    constructor() {
        super();
        this.sessions = new Map(); // key: sessionId -> { sock, status, qrCodeData, queue, isProcessingQueue, webhookUrl }
        this.sessionsDir = path.join(__dirname, process.env.SESSIONS_DIR || 'wa_sessions');
        this.webhookUrl = process.env.WEBHOOK_URL || null;
        this.reconnectTimeouts = new Map(); // key: sessionId -> setTimeout ID

        // Custom logger for Baileys to avoid polluting our console too much
        this.logger = pino({ level: 'silent' });
    }

    // Helper to format phone number to WhatsApp JID
    formatJid(number) {
        let cleanNumber = number.replace(/\D/g, '');
        if (cleanNumber.startsWith('0')) {
            cleanNumber = '62' + cleanNumber.substring(1);
        }
        if (!cleanNumber.endsWith('@s.whatsapp.net')) {
            cleanNumber = `${cleanNumber}@s.whatsapp.net`;
        }
        return cleanNumber;
    }

    // Restore previously connected sessions on boot
    async restoreSessions() {
        this.emit('log', 'Scanning for saved sessions...');
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
            return;
        }

        try {
            const files = fs.readdirSync(this.sessionsDir);
            for (const file of files) {
                const sessionPath = path.join(this.sessionsDir, file);
                if (fs.statSync(sessionPath).isDirectory()) {
                    this.emit('log', `Restoring session: ${file}...`);
                    // Initialize the session in background so boot is non-blocking
                    this.createSession(file).catch(err => {
                        this.emit('log', `[${file}] Failed to restore: ${err.message}`);
                    });
                }
            }
        } catch (err) {
            this.emit('log', `Error scanning sessions folder: ${err.message}`);
        }
    }

    // Initialize/Create a WhatsApp session
    async createSession(sessionId, phoneNumber = null) {
        this.emit('log', `[${sessionId}] Initializing session...`);

        // Clean up session if it already exists
        if (this.sessions.has(sessionId)) {
            const existing = this.sessions.get(sessionId);
            if (existing.status === 'connected') {
                this.emit('log', `[${sessionId}] Session is already connected and active.`);
                return existing;
            }
            await this.cleanupSocket(sessionId);
        }

        const sessionFolder = path.join(this.sessionsDir, sessionId);
        if (!fs.existsSync(sessionFolder)) {
            fs.mkdirSync(sessionFolder, { recursive: true });
        }

        // Load Session Webhook Settings if they exist
        let sessionWebhook = null;
        const metadataPath = path.join(sessionFolder, 'metadata.json');
        if (fs.existsSync(metadataPath)) {
            try {
                const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
                sessionWebhook = metadata.webhookUrl || null;
            } catch (err) {
                this.emit('log', `[${sessionId}] Failed to read metadata.json: ${err.message}`);
            }
        }

        // Set initial state
        const sessionObj = {
            sock: null,
            status: 'connecting',
            qrCodeData: null,
            pairingCode: null,
            queue: [],
            isProcessingQueue: false,
            webhookUrl: sessionWebhook
        };
        this.sessions.set(sessionId, sessionObj);
        this.emit('status', { sessionId, status: 'connecting' });

        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

        // Fetch latest version or fallback to stable
        let version = [2, 3000, 1015901307];
        try {
            const latest = await fetchLatestBaileysVersion();
            version = latest.version;
            this.emit('log', `[${sessionId}] Using WhatsApp version: ${version.join('.')}`);
        } catch (err) {
            this.emit('log', `[${sessionId}] Using fallback WhatsApp version: ${version.join('.')}`);
        }

        const sock = makeWASocket({
            version,
            auth: state,
            logger: this.logger,
            browser: Browsers.macOS('Desktop'),
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
        });

        sessionObj.sock = sock;

        // Credentials save handler
        sock.ev.on('creds.update', saveCreds);

        // Connection update listener
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                sessionObj.status = 'qr';
                sessionObj.reconnectAttempts = 0;

                // Request pairing code if phone number is provided during creation and we haven't requested it yet
                if (phoneNumber && !sessionObj.pairingCode) {
                    try {
                        const cleanPhone = phoneNumber.replace(/\D/g, '');
                        this.emit('log', `[${sessionId}] Requesting pairing code for JID: ${cleanPhone} during socket initialization...`);
                        const code = await sock.requestPairingCode(cleanPhone);
                        sessionObj.pairingCode = code;
                        this.emit('status', { sessionId, status: 'qr' }); // Refresh to display the code
                        this.emit('log', `[${sessionId}] Pairing Code generated: ${code}`);
                    } catch (err) {
                        this.emit('log', `[${sessionId}] Failed to generate pairing code: ${err.message}`);
                        // Fallback to displaying QR code if pairing fails
                        try {
                            sessionObj.qrCodeData = await QRCode.toDataURL(qr);
                            this.emit('qr', { sessionId, qrCode: sessionObj.qrCodeData });
                        } catch (qrErr) {}
                    }
                } else if (!phoneNumber) {
                    // Regular QR code flow
                    try {
                        sessionObj.qrCodeData = await QRCode.toDataURL(qr);
                        this.emit('qr', { sessionId, qrCode: sessionObj.qrCodeData });
                        this.emit('status', { sessionId, status: 'qr' });
                        this.emit('log', `[${sessionId}] New QR Code generated.`);
                    } catch (err) {
                        this.emit('log', `[${sessionId}] Error rendering QR: ${err.message}`);
                    }
                }
            }

            if (connection === 'connecting') {
                sessionObj.status = 'connecting';
                this.emit('status', { sessionId, status: 'connecting' });
                this.emit('log', `[${sessionId}] Connecting to WhatsApp...`);
            }

            if (connection === 'open') {
                sessionObj.status = 'connected';
                sessionObj.qrCodeData = null;
                this.emit('status', { sessionId, status: 'connected' });
                this.emit('log', `[${sessionId}] Connected successfully!`);

                this.triggerWebhook({
                    event: 'connection_status',
                    session: sessionId,
                    status: 'connected',
                    timestamp: new Date().toISOString()
                });

                // Trigger background queue processor upon connection
                this.startQueueWorker(sessionId);
            }

            if (connection === 'close') {
                const isRegistered = sock.authState?.creds?.registered;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const errDetail = lastDisconnect?.error?.message || lastDisconnect?.error || 'unknown';
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                
                // Allow reconnection if not explicitly logged out
                sessionObj.reconnectAttempts = (sessionObj.reconnectAttempts || 0) + 1;
                const maxUnregisteredRetries = 5;
                const shouldReconnect = !isLoggedOut && (isRegistered || sessionObj.reconnectAttempts <= maxUnregisteredRetries);
                
                this.emit('log', `[${sessionId}] Connection closed (code: ${statusCode || 'N/A'}). Detail: ${errDetail}. Attempt: ${sessionObj.reconnectAttempts}. Reconnecting: ${shouldReconnect}`);

                if (shouldReconnect) {
                    sessionObj.status = 'connecting';
                    this.emit('status', { sessionId, status: 'connecting' });

                    if (this.reconnectTimeouts.has(sessionId)) {
                        clearTimeout(this.reconnectTimeouts.get(sessionId));
                    }

                    const delayMs = statusCode === DisconnectReason.restartRequired ? 1000 : 3000;
                    const timeout = setTimeout(() => {
                        this.createSession(sessionId, phoneNumber);
                    }, delayMs);
                    this.reconnectTimeouts.set(sessionId, timeout);
                } else {
                    sessionObj.status = 'disconnected';
                    sessionObj.qrCodeData = null;
                    sessionObj.pairingCode = null;
                    sessionObj.reconnectAttempts = 0;
                    this.emit('status', { sessionId, status: 'disconnected' });
                    this.emit('log', `[${sessionId}] Session stopped.`);

                    if (isLoggedOut) {
                        this.emit('log', `[${sessionId}] Session logged out. Deleting credentials...`);
                        this.clearSessionFiles(sessionId);
                        this.sessions.delete(sessionId);
                    }
                }

                this.triggerWebhook({
                    event: 'connection_status',
                    session: sessionId,
                    status: sessionObj.status,
                    timestamp: new Date().toISOString()
                });
            }
        });

        // Upsert message listener
        sock.ev.on('messages.upsert', async (m) => {
            if (m.type !== 'notify') return;

            for (const message of m.messages) {
                if (message.key.fromMe) continue;

                const messageType = Object.keys(message.message || {})[0];
                let textContent = '';

                if (messageType === 'conversation') {
                    textContent = message.message.conversation;
                } else if (messageType === 'extendedTextMessage') {
                    textContent = message.message.extendedTextMessage.text;
                } else if (messageType === 'imageMessage' || messageType === 'videoMessage') {
                    textContent = message.message[messageType].caption || '';
                }

                const senderJid = message.key.remoteJid;
                const senderName = message.pushName || 'Unknown';
                const isGroup = senderJid.endsWith('@g.us');

                const messagePayload = {
                    event: 'message_received',
                    session: sessionId,
                    id: message.key.id,
                    from: senderJid.split('@')[0],
                    name: senderName,
                    isGroup,
                    messageType,
                    body: textContent,
                    timestamp: message.messageTimestamp
                };

                this.emit('message', messagePayload);
                this.emit('log', `[${sessionId}] Received message from ${senderName}: ${textContent}`);

                // Save incoming message to SQLite database
                const ownNumber = sock?.user?.id ? sock.user.id.split(':')[0] : null;
                insertMessage({
                    messageId: message.key.id,
                    sessionId: sessionId,
                    sender: senderJid.split('@')[0],
                    receiver: ownNumber,
                    messageType: messageType || 'text',
                    body: textContent || '',
                    direction: 'incoming',
                    status: 'received',
                    timestamp: new Date(message.messageTimestamp * 1000).toISOString()
                }).then(() => {
                    this.emit('history-updated', { sessionId });
                }).catch(err => {
                    this.emit('log', `[Database Error] Failed to log incoming message: ${err.message}`);
                });

                this.triggerWebhook(messagePayload);
            }
        });

        return sessionObj;
    }

    // Save metadata for a session
    saveSessionMetadata(sessionId, metadata) {
        const sessionFolder = path.join(this.sessionsDir, sessionId);
        if (!fs.existsSync(sessionFolder)) {
            fs.mkdirSync(sessionFolder, { recursive: true });
        }

        const metadataPath = path.join(sessionFolder, 'metadata.json');
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');

        // Update active session metadata in memory
        const session = this.sessions.get(sessionId);
        if (session) {
            session.webhookUrl = metadata.webhookUrl || null;
        }

        this.emit('log', `[${sessionId}] Saved session configuration. Webhook URL: ${metadata.webhookUrl || 'Not set'}`);
    }

    // Request a pairing code for a session
    async requestPairingCode(sessionId, phoneNumber) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`WhatsApp session "${sessionId}" not found.`);
        }
        if (!session.sock) {
            throw new Error('Socket is not initialized yet. Please wait a moment.');
        }

        const cleanPhone = phoneNumber.replace(/\D/g, '');
        this.emit('log', `[${sessionId}] Requesting pairing code for: ${cleanPhone}...`);
        
        try {
            const code = await session.sock.requestPairingCode(cleanPhone);
            this.emit('log', `[${sessionId}] Pairing code generated successfully: ${code}`);
            return code;
        } catch (err) {
            this.emit('log', `[${sessionId}] Failed to request pairing code: ${err.message}`);
            throw err;
        }
    }

    // Helper to send Webhook payload
    async triggerWebhook(payload) {
        let targetUrl = this.webhookUrl; // fallback to global webhook

        if (payload && payload.session) {
            const session = this.sessions.get(payload.session);
            if (session && session.webhookUrl) {
                targetUrl = session.webhookUrl;
            }
        }

        if (!targetUrl) return;

        try {
            await axios.post(targetUrl, payload, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 5000
            });
        } catch (err) {
            this.emit('log', `[System] Webhook delivery failed to ${targetUrl}: ${err.message}`);
        }
    }

    // Media Downloader Helper
    async downloadMedia(url) {
        this.emit('log', `Downloading attachment from: ${url}...`);
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 15000 // 15 seconds timeout
        });
        
        const buffer = Buffer.from(response.data);
        const contentType = response.headers['content-type'] || 'application/octet-stream';
        
        return { buffer, contentType };
    }

    // Queue worker triggers
    enqueueMessage(sessionId, to, text, mediaUrl = null, filename = null, caption = null) {
        const session = this.sessions.get(sessionId);
        if (!session) return -1;

        const tempId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

        session.queue.push({ tempId, to, text, mediaUrl, filename, caption });
        this.emit('log', `[${sessionId}] Message added to queue. Queue size: ${session.queue.length}`);
        
        // Log to database as queued
        const ownNumber = session.sock?.user?.id ? session.sock.user.id.split(':')[0] : null;
        insertMessage({
            messageId: tempId,
            sessionId: sessionId,
            sender: ownNumber,
            receiver: to,
            messageType: mediaUrl ? 'media' : 'text',
            body: caption || text || '',
            mediaUrl: mediaUrl,
            direction: 'outgoing',
            status: 'queued',
            timestamp: new Date().toISOString()
        }).then(() => {
            this.emit('history-updated', { sessionId });
        }).catch(err => {
            this.emit('log', `[Database Error] Failed to log queued message: ${err.message}`);
        });

        this.startQueueWorker(sessionId);
        return session.queue.length;
    }

    startQueueWorker(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        if (session.status === 'connected' && !session.isProcessingQueue && session.queue.length > 0) {
            session.isProcessingQueue = true;
            this.processQueue(sessionId);
        }
    }

    async processQueue(sessionId) {
        const session = this.sessions.get(sessionId);
        
        // Stop worker if session becomes invalid, disconnected or queue is empty
        if (!session || session.status !== 'connected' || session.queue.length === 0) {
            if (session) session.isProcessingQueue = false;
            return;
        }

        const task = session.queue.shift();

        try {
            const jid = this.formatJid(task.to);
            let response;

            if (task.mediaUrl) {
                this.emit('log', `[${sessionId}] Processing media from queue to ${jid}...`);
                const { buffer, contentType } = await this.downloadMedia(task.mediaUrl);
                
                const messageCaption = task.caption || task.text || '';
                
                if (contentType.startsWith('image/')) {
                    response = await session.sock.sendMessage(jid, { 
                        image: buffer, 
                        caption: messageCaption 
                    });
                } else if (contentType.startsWith('video/')) {
                    response = await session.sock.sendMessage(jid, { 
                        video: buffer, 
                        caption: messageCaption 
                    });
                } else {
                    // Send as document (PDF, Excel, Docx, etc.)
                    const fallbackFilename = task.filename || path.basename(new URL(task.mediaUrl).pathname) || 'document';
                    response = await session.sock.sendMessage(jid, { 
                        document: buffer, 
                        mimetype: contentType, 
                        fileName: fallbackFilename,
                        caption: messageCaption
                    });
                }
            } else {
                this.emit('log', `[${sessionId}] Sending text message to ${jid} from queue...`);
                response = await session.sock.sendMessage(jid, { text: task.text });
            }

            this.emit('log', `[${sessionId}] Message sent successfully! ID: ${response.key.id}`);

            // Update database status to sent
            const ownNumber = session.sock?.user?.id ? session.sock.user.id.split(':')[0] : null;
            updateMessageStatus(task.tempId, {
                status: 'sent',
                messageId: response.key.id,
                sender: ownNumber,
                timestamp: new Date(response.messageTimestamp * 1000).toISOString()
            }).then(() => {
                this.emit('history-updated', { sessionId });
            }).catch(dbErr => {
                this.emit('log', `[Database Error] Failed to update sent status: ${dbErr.message}`);
            });

            this.triggerWebhook({
                event: 'message_sent',
                session: sessionId,
                id: response.key.id,
                to: jid,
                status: 'sent',
                timestamp: response.messageTimestamp
            });
        } catch (err) {
            this.emit('log', `[${sessionId}] Failed to send queued message to ${task.to}: ${err.message}`);
            
            // Update database status to failed
            updateMessageStatus(task.tempId, {
                status: 'failed',
                errorMessage: err.message,
                timestamp: new Date().toISOString()
            }).then(() => {
                this.emit('history-updated', { sessionId });
            }).catch(dbErr => {
                this.emit('log', `[Database Error] Failed to update failed status: ${dbErr.message}`);
            });

            this.triggerWebhook({
                event: 'message_failed',
                session: sessionId,
                to: task.to,
                error: err.message,
                timestamp: new Date().toISOString()
            });
        }

        // Random delay between 2-5 seconds for anti-spam behavior
        const delayMs = Math.floor(Math.random() * (5000 - 2000 + 1)) + 2000;
        this.emit('log', `[${sessionId}] Queue sleeping for ${(delayMs / 1000).toFixed(1)}s (Anti-Spam). Queue size: ${session.queue.length}`);

        setTimeout(() => {
            this.processQueue(sessionId);
        }, delayMs);
    }

    // Close socket connection
    async cleanupSocket(sessionId) {
        if (this.reconnectTimeouts.has(sessionId)) {
            clearTimeout(this.reconnectTimeouts.get(sessionId));
            this.reconnectTimeouts.delete(sessionId);
        }

        const session = this.sessions.get(sessionId);
        if (session) {
            session.isProcessingQueue = false;
            if (session.sock) {
                try {
                    session.sock.ev.removeAllListeners();
                } catch (e) {}
                try {
                    session.sock.ws.close();
                } catch (e) {}
                session.sock = null;
            }
        }
    }

    // Delete session files
    clearSessionFiles(sessionId) {
        const sessionFolder = path.join(this.sessionsDir, sessionId);
        if (fs.existsSync(sessionFolder)) {
            try {
                fs.rmSync(sessionFolder, { recursive: true, force: true });
                this.emit('log', `[${sessionId}] Session folder deleted.`);
            } catch (err) {
                this.emit('log', `[${sessionId}] Failed to delete session folder: ${err.message}`);
            }
        }
    }

    // Logout WhatsApp session
    async logout(sessionId) {
        this.emit('log', `[${sessionId}] Logging out session...`);
        const session = this.sessions.get(sessionId);
        
        await this.cleanupSocket(sessionId);

        if (session && session.sock) {
            try {
                await session.sock.logout();
            } catch (err) {
                this.emit('log', `[${sessionId}] Logout err: ${err.message}`);
            }
        }

        this.clearSessionFiles(sessionId);
        this.sessions.delete(sessionId);
        this.emit('status', { sessionId, status: 'disconnected' });
    }

    // Send message (text or media) through a session
    async sendMessage(sessionId, to, text, mediaUrl = null, filename = null, caption = null) {
        let activeSessionId = sessionId;

        // Fallback to first session if none is provided
        if (!activeSessionId) {
            const activeKeys = Array.from(this.sessions.keys());
            if (activeKeys.length > 0) {
                activeSessionId = activeKeys[0];
            } else {
                throw new Error('No active WhatsApp sessions found on server.');
            }
        }

        const session = this.sessions.get(activeSessionId);
        if (!session) {
            throw new Error(`WhatsApp session "${activeSessionId}" not found.`);
        }

        if (session.status === 'disconnected') {
            throw new Error(`WhatsApp session "${activeSessionId}" is offline.`);
        }

        // Add to queue
        const queueLength = this.enqueueMessage(activeSessionId, to, text, mediaUrl, filename, caption);
        
        return {
            status: 'queued',
            session: activeSessionId,
            queuePosition: queueLength,
            message: 'Message added to queue.'
        };
    }

    // Get details of all sessions
    listSessions() {
        const list = [];
        this.sessions.forEach((val, key) => {
            list.push({
                sessionId: key,
                status: val.status,
                hasQr: !!val.qrCodeData,
                qrCode: val.qrCodeData,
                pairingCode: val.pairingCode || null,
                queueLength: val.queue ? val.queue.length : 0,
                webhookUrl: val.webhookUrl || null
            });
        });
        return list;
    }

    // Set Webhook URL
    setWebhookUrl(url) {
        this.webhookUrl = url || null;
        this.emit('log', `Webhook URL updated to: ${url}`);
    }
}

const gatewayInstance = new WhatsAppGateway();
export default gatewayInstance;
