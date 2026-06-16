import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database file path inside SESSIONS_DIR (defaults to 'wa_sessions')
const sessionsDir = path.resolve(__dirname, process.env.SESSIONS_DIR || 'wa_sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}
const dbPath = path.join(sessionsDir, 'gateway.db');

// Connect to SQLite database
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('[Database] Failed to connect:', err.message);
    } else {
        console.log(`[Database] SQLite connected successfully at: ${dbPath}`);
    }
});

// Promise wrappers for sqlite3 callbacks
const queryRun = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
};

const queryAll = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

const queryGet = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

// Initialize schema on server startup
export const initDb = async () => {
    try {
        await queryRun(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id TEXT UNIQUE,
                session_id TEXT NOT NULL,
                sender TEXT,
                receiver TEXT,
                message_type TEXT DEFAULT 'text',
                body TEXT,
                media_url TEXT,
                direction TEXT CHECK(direction IN ('incoming', 'outgoing')),
                status TEXT CHECK(status IN ('queued', 'sent', 'failed', 'received')),
                error_message TEXT,
                timestamp TEXT NOT NULL
            )
        `);

        // Index definitions for query performance
        await queryRun(`CREATE INDEX IF NOT EXISTS idx_session_timestamp ON messages(session_id, timestamp)`);
        await queryRun(`CREATE INDEX IF NOT EXISTS idx_message_id ON messages(message_id)`);
        await queryRun(`CREATE INDEX IF NOT EXISTS idx_status ON messages(status)`);
        
        console.log('[Database] Schema checked and initialized.');
    } catch (err) {
        console.error('[Database] Error initializing database schema:', err.message);
        throw err;
    }
};

// Insert a log record
export const insertMessage = async (msg) => {
    const sql = `
        INSERT OR IGNORE INTO messages (message_id, session_id, sender, receiver, message_type, body, media_url, direction, status, error_message, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const timestamp = msg.timestamp || new Date().toISOString();
    return await queryRun(sql, [
        msg.messageId,
        msg.sessionId,
        msg.sender || null,
        msg.receiver || null,
        msg.messageType || 'text',
        msg.body || null,
        msg.mediaUrl || null,
        msg.direction,
        msg.status,
        msg.errorMessage || null,
        timestamp
    ]);
};

// Update message delivery state or resolve temp IDs to final WhatsApp IDs
export const updateMessageStatus = async (idOrTempId, updateData) => {
    let sql = `UPDATE messages SET `;
    const fields = [];
    const params = [];

    if (updateData.status) {
        fields.push(`status = ?`);
        params.push(updateData.status);
    }
    if (updateData.messageId) {
        fields.push(`message_id = ?`);
        params.push(updateData.messageId);
    }
    if (updateData.errorMessage !== undefined) {
        fields.push(`error_message = ?`);
        params.push(updateData.errorMessage);
    }
    if (updateData.timestamp) {
        fields.push(`timestamp = ?`);
        params.push(updateData.timestamp);
    }

    if (fields.length === 0) return;

    sql += fields.join(', ') + ` WHERE message_id = ? OR id = ?`;
    params.push(idOrTempId, idOrTempId);

    return await queryRun(sql, params);
};

// Query list of messages with sorting, filtering, and pagination support
export const getMessages = async (filters = {}, limit = 50, offset = 0) => {
    let query = `SELECT * FROM messages WHERE 1=1`;
    let countQuery = `SELECT COUNT(*) as total FROM messages WHERE 1=1`;
    const params = [];

    if (filters.session) {
        query += ` AND session_id = ?`;
        countQuery += ` AND session_id = ?`;
        params.push(filters.session);
    }
    if (filters.status) {
        query += ` AND status = ?`;
        countQuery += ` AND status = ?`;
        params.push(filters.status);
    }
    if (filters.direction) {
        query += ` AND direction = ?`;
        countQuery += ` AND direction = ?`;
        params.push(filters.direction);
    }
    if (filters.search) {
        const searchPattern = `%${filters.search}%`;
        query += ` AND (sender LIKE ? OR receiver LIKE ? OR body LIKE ?)`;
        countQuery += ` AND (sender LIKE ? OR receiver LIKE ? OR body LIKE ?)`;
        params.push(searchPattern, searchPattern, searchPattern);
    }

    query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
    
    try {
        const countResult = await queryGet(countQuery, params);
        const total = countResult ? countResult.total : 0;
        
        const messages = await queryAll(query, [...params, limit, offset]);
        return { total, messages };
    } catch (err) {
        console.error('[Database] Failed to get messages:', err.message);
        return { total: 0, messages: [] };
    }
};

// Clear history
export const clearMessages = async (sessionId = null) => {
    if (sessionId) {
        return await queryRun(`DELETE FROM messages WHERE session_id = ?`, [sessionId]);
    } else {
        return await queryRun(`DELETE FROM messages`);
    }
};
