const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'app.db');
const DB_DIR = path.dirname(DB_PATH);

// Garante que o diretório existe
if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// Inicializa as tabelas
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            unread_count INTEGER NOT NULL DEFAULT 0,
            last_message_at TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            chat_id TEXT NOT NULL,
            direction TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            file_id TEXT,
            file_name TEXT,
            file_type TEXT,
            FOREIGN KEY (chat_id) REFERENCES chats(id)
        );

        CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
        CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
        CREATE INDEX IF NOT EXISTS idx_chats_updated_at ON chats(updated_at);
    `);
    
    // Adiciona coluna audio_id se não existir
    try {
        db.exec(`ALTER TABLE messages ADD COLUMN audio_id TEXT;`);
        console.log('✅ Coluna audio_id adicionada');
    } catch (e) {
        // Coluna já existe
    }

    // Adiciona colunas de anexo se não existirem
    try { db.exec(`ALTER TABLE messages ADD COLUMN file_id TEXT;`); } catch (_) {}
    try { db.exec(`ALTER TABLE messages ADD COLUMN file_name TEXT;`); } catch (_) {}
    try { db.exec(`ALTER TABLE messages ADD COLUMN file_type TEXT;`); } catch (_) {}
    
    console.log('✅ Banco de dados SQLite inicializado com sucesso');
} catch (error) {
    console.error('❌ Erro ao inicializar banco de dados:', error);
}

class DatabaseStore {
    // === CHATS ===
    
    upsertChat(chatId, name = '') {
        try {
            const stmt = db.prepare(`
                INSERT INTO chats (id, name, unread_count, last_message_at, updated_at)
                VALUES (?, ?, 0, datetime('now'), datetime('now'))
                ON CONFLICT(id) DO UPDATE 
                SET name = CASE WHEN ? = '' THEN chats.name ELSE ? END,
                    updated_at = datetime('now')
            `);
            stmt.run(chatId, name || '', name || '', name || '');
        } catch (e) {
            console.error('Erro ao inserir/atualizar chat:', e);
        }
    }

    recordIncomingMessage({ chatId, sender, text, timestamp, name, audioId, fileId, fileName, fileType }) {
        const messageId = `${chatId}:${timestamp}`;
        
        // Insere/atualiza chat
        this.upsertChat(chatId, name);
        
        // Insere mensagem
        const msgStmt = db.prepare(`
            INSERT INTO messages (id, chat_id, direction, content, timestamp, audio_id, file_id, file_name, file_type)
            VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?)
        `);
        msgStmt.run(messageId, chatId, text || '', timestamp, audioId || null, fileId || null, fileName || null, fileType || null);
        
        // Atualiza contador e última mensagem
        const updateStmt = db.prepare(`
            UPDATE chats 
            SET unread_count = unread_count + 1,
                last_message_at = datetime(?, 'unixepoch'),
                updated_at = datetime('now')
            WHERE id = ?
        `);
        updateStmt.run(timestamp / 1000, chatId);
        
        return { id: messageId, direction: 'in', sender, text, timestamp };
    }

    recordOutgoingMessage({ chatId, text, timestamp, audioId, fileId, fileName, fileType }) {
        const messageId = `${chatId}:out:${timestamp}`;
        
        // Garante que o chat exista
        try { this.upsertChat(chatId); } catch (_) {}

        // Insere mensagem
        const msgStmt = db.prepare(`
            INSERT INTO messages (id, chat_id, direction, content, timestamp, audio_id, file_id, file_name, file_type)
            VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?)
        `);
        msgStmt.run(messageId, chatId, text || '', timestamp, audioId || null, fileId || null, fileName || null, fileType || null);
        
        // Atualiza última mensagem (sem incrementar unread_count)
        const updateStmt = db.prepare(`
            UPDATE chats 
            SET last_message_at = datetime(?, 'unixepoch'),
                updated_at = datetime('now')
            WHERE id = ?
        `);
        updateStmt.run(timestamp / 1000, chatId);
        
        return { id: messageId, direction: 'out', sender: 'bot', text, timestamp };
    }

    markRead(chatId) {
        const stmt = db.prepare(`
            UPDATE chats 
            SET unread_count = 0, updated_at = datetime('now')
            WHERE id = ?
        `);
        stmt.run(chatId);
        return true;
    }

    listChats() {
        try {
            const stmt = db.prepare(`
                SELECT c.*,
                       m.content as last_message_content,
                       m.timestamp as last_message_timestamp
                FROM chats c
                LEFT JOIN messages m ON m.id = (
                    SELECT id 
                    FROM messages 
                    WHERE chat_id = c.id 
                    ORDER BY timestamp DESC 
                    LIMIT 1
                )
                ORDER BY c.updated_at DESC
            `);
            
            const rows = stmt.all();
            
            return rows.map(row => ({
                id: row.id,
                name: row.name || '',
                unreadCount: row.unread_count || 0,
                lastMessage: row.last_message_content ? {
                    text: row.last_message_content,
                    timestamp: row.last_message_timestamp
                } : null,
                updatedAt: row.updated_at
            }));
        } catch (e) {
            console.error('Erro ao listar chats:', e);
            return [];
        }
    }

    getChat(chatId) {
        try {
            const chatStmt = db.prepare('SELECT * FROM chats WHERE id = ?');
            const chat = chatStmt.get(chatId);
            
            if (!chat) return null;
            
            const messagesStmt = db.prepare(`
                SELECT id, direction, content as text, timestamp, audio_id, file_id, file_name, file_type
                FROM messages
                WHERE chat_id = ?
                ORDER BY timestamp ASC
                LIMIT 500
            `);
            
            const messages = messagesStmt.all(chatId).map(row => ({
                id: row.id,
                direction: row.direction,
                text: row.text,
                timestamp: row.timestamp,
                audioId: row.audio_id,
                fileId: row.file_id,
                fileName: row.file_name,
                fileType: row.file_type
            }));
            
            return {
                id: chat.id,
                name: chat.name || '',
                unreadCount: chat.unread_count || 0,
                lastMessage: messages.length > 0 ? messages[messages.length - 1] : null,
                updatedAt: chat.updated_at,
                messages
            };
        } catch (e) {
            console.error('Erro ao obter chat:', e);
            return null;
        }
    }

    /**
     * Verifica se já existe uma mensagem de saída recente com mesmo texto
     * para evitar duplicidade quando capturamos mensagens enviadas pelo WhatsApp.
     */
    hasSimilarRecentOutgoing(chatId, text, windowMs = 10000) {
        try {
            const threshold = Date.now() - windowMs;
            const trimmedText = (text || '').trim();
            
            // Verifica exatamente o texto
            const stmt = db.prepare(`
                SELECT 1 FROM messages
                WHERE chat_id = ? AND direction = 'out' AND content = ? AND timestamp >= ?
                LIMIT 1
            `);
            const row = stmt.get(chatId, trimmedText, threshold);
            if (row) return true;
            
            // Verifica se há mensagem muito similar (sem diferenças de espaços/case)
            const stmtSimilar = db.prepare(`
                SELECT 1 FROM messages
                WHERE chat_id = ? AND direction = 'out' AND timestamp >= ?
                AND LOWER(TRIM(content)) = LOWER(?)
                LIMIT 1
            `);
            const rowSimilar = stmtSimilar.get(chatId, threshold, trimmedText);
            return !!rowSimilar;
        } catch (e) {
            return false;
        }
    }
}

module.exports = new DatabaseStore();

