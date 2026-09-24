import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import gateway from './gateway.js';
import { initDb, getMessages, clearMessages } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Key Middleware for secure routes
const authenticateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    const serverKey = (process.env.API_KEY || 'my_secure_super_secret_key_123').trim();
    if (!apiKey || apiKey.trim() !== serverKey) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key.' });
    }
    next();
};

// WebSocket Real-time communications
io.on('connection', (socket) => {
    console.log('Dashboard client connected:', socket.id);

    // Send the list of all active sessions to the dashboard on connect
    socket.emit('sessions-list', gateway.listSessions());
    
    const webhookUrl = gateway.webhookUrl;
    socket.emit('log', `[System] Connected to dashboard server. Webhook URL: ${webhookUrl || 'Not set'}`);

    // Handle session creation requested from dashboard
    socket.on('create-session', async ({ sessionId }) => {
        if (!sessionId) return;
        try {
            await gateway.createSession(sessionId);
        } catch (err) {
            socket.emit('log', `[System] Failed to create session "${sessionId}": ${err.message}`);
        }
    });

    // Handle request for phone number pairing code
    socket.on('request-pairing-code', async ({ sessionId, phoneNumber }) => {
        if (!sessionId || !phoneNumber) return;
        try {
            const code = await gateway.requestPairingCode(sessionId, phoneNumber);
            socket.emit('pairing-code-response', { sessionId, code });
        } catch (err) {
            socket.emit('log', `[System] Failed to generate pairing code: ${err.message}`);
            socket.emit('pairing-code-response', { sessionId, error: err.message });
        }
    });

    // Handle logout requested from dashboard
    socket.on('logout-session', async ({ sessionId }) => {
        if (!sessionId) return;
        try {
            await gateway.logout(sessionId);
        } catch (err) {
            socket.emit('log', `[System] Failed to logout session "${sessionId}": ${err.message}`);
        }
    });

    socket.on('disconnect', () => {
        console.log('Dashboard client disconnected:', socket.id);
    });
});

// Relay events from gateway to WebSockets
gateway.on('status', ({ sessionId, status }) => {
    io.emit('status', { sessionId, status });
    io.emit('sessions-list', gateway.listSessions()); // Refresh session list
});

gateway.on('qr', ({ sessionId, qrCode }) => {
    io.emit('qr', { sessionId, qrCode });
});

gateway.on('log', (message) => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[Gateway] ${message}`);
    io.emit('log', `[${timestamp}] ${message}`);
});

gateway.on('message', (messagePayload) => {
    io.emit('message', messagePayload);
});

gateway.on('history-updated', ({ sessionId }) => {
    io.emit('history-updated', { sessionId });
});

// REST API Endpoints
// Config check (used by dashboard to display initial data)
app.get('/api/config', (req, res) => {
    res.json({
        port: PORT,
        webhookUrl: gateway.webhookUrl,
        hasApiKey: !!API_KEY
    });
});

// Secure endpoint to check all sessions status
app.get('/api/sessions', authenticateApiKey, (req, res) => {
    res.json(gateway.listSessions());
});

// Secure endpoint to create a new session
app.post('/api/sessions/create', authenticateApiKey, async (req, res) => {
    const { session } = req.body;

    if (!session) {
        return res.status(400).json({ error: 'Missing required parameter: "session".' });
    }

    try {
        await gateway.createSession(session);
        return res.json({ status: 'success', message: `Initializing session "${session}"` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Secure endpoint to logout a session
app.post('/api/sessions/logout', authenticateApiKey, async (req, res) => {
    const { session } = req.body;

    if (!session) {
        return res.status(400).json({ error: 'Missing required parameter: "session".' });
    }

    try {
        await gateway.logout(session);
        return res.json({ status: 'success', message: `Session "${session}" logged out.` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Secure endpoint to send message (text or media)
app.post('/api/send-message', authenticateApiKey, async (req, res) => {
    const { session, to, message, mediaUrl, filename, caption } = req.body;

    if (!to) {
        return res.status(400).json({ error: 'Missing required parameter: "to".' });
    }

    if (!message && !mediaUrl) {
        return res.status(400).json({ error: 'Either "message" or "mediaUrl" must be provided.' });
    }

    try {
        const result = await gateway.sendMessage(session, to, message, mediaUrl, filename, caption);
        return res.json(result);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Secure endpoint to update settings for a specific session
app.post('/api/sessions/settings', authenticateApiKey, (req, res) => {
    const { session, webhookUrl } = req.body;

    if (!session) {
        return res.status(400).json({ error: 'Missing required parameter: "session".' });
    }

    try {
        gateway.saveSessionMetadata(session, { webhookUrl });
        return res.json({ 
            status: 'success', 
            message: `Settings updated for session "${session}".`,
            webhookUrl
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Secure endpoint to configure settings dynamically
app.post('/api/settings', authenticateApiKey, (req, res) => {
    const { webhookUrl } = req.body;
    gateway.setWebhookUrl(webhookUrl);
    return res.json({ 
        status: 'success', 
        message: 'Settings updated successfully.',
        webhookUrl: gateway.webhookUrl
    });
});

// Secure endpoint to get message history
app.get('/api/history', authenticateApiKey, async (req, res) => {
    const { session, status, direction, search, limit, offset } = req.query;
    
    const parsedLimit = parseInt(limit, 10) || 50;
    const parsedOffset = parseInt(offset, 10) || 0;
    
    try {
        const result = await getMessages(
            { session, status, direction, search },
            parsedLimit,
            parsedOffset
        );
        return res.json(result);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Secure endpoint to clear history
app.post('/api/history/clear', authenticateApiKey, async (req, res) => {
    const { session } = req.body;
    try {
        await clearMessages(session);
        // Notify clients that history was cleared
        io.emit('history-updated', { sessionId: session || null });
        return res.json({ status: 'success', message: 'History cleared successfully.' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Catch-all for undefined routes
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Start server and restore existing sessions
server.listen(PORT, async () => {
    console.log(`=================================================`);
    console.log(`🚀 WA Multi-Session Gateway running on http://localhost:${PORT}`);
    console.log(`🔐 Active API Key: ${process.env.API_KEY ? process.env.API_KEY.trim() : 'my_secure_super_secret_key_123 (Default)'}`);
    console.log(`=================================================`);
    
    try {
        await initDb();
        await gateway.restoreSessions();
    } catch (err) {
        console.error('Failed to initialize database or restore WhatsApp sessions:', err);
    }
});
