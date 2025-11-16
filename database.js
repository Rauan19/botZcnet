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

const normalizeValue = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'object') {
        if (value._serialized) return value._serialized;
        if (value.id) return value.id;
        try { return JSON.stringify(value); } catch (_) { return String(value); }
    }
    return value;
};

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
    
    // Adiciona coluna bot_paused se não existir
    try {
        db.exec(`ALTER TABLE chats ADD COLUMN bot_paused INTEGER NOT NULL DEFAULT 0;`);
        console.log('✅ Coluna bot_paused adicionada');
    } catch (e) {
        // Coluna já existe
    }
    
    // Adiciona coluna last_attendant_message_at se não existir
    try {
        db.exec(`ALTER TABLE chats ADD COLUMN last_attendant_message_at INTEGER;`);
        console.log('✅ Coluna last_attendant_message_at adicionada');
    } catch (e) {
        // Coluna já existe
    }
    
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
            INSERT INTO messages (id, chat_id, direction, content, timestamp, file_id, file_name, file_type, audio_id)
            VALUES (@id, @chat_id, @direction, @content, @timestamp, @file_id, @file_name, @file_type, @audio_id)
        `);
        msgStmt.run({
            id: messageId,
            chat_id: chatId,
            direction: 'in',
            content: text || '',
            timestamp,
            file_id: normalizeValue(fileId),
            file_name: normalizeValue(fileName),
            file_type: normalizeValue(fileType),
            audio_id: normalizeValue(audioId)
        });
        
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

    recordOutgoingMessage({ chatId, text, timestamp, audioId, fileId, fileName, fileType, isAttendant = false }) {
        const messageId = `${chatId}:out:${timestamp}`;
        
        // Dedupe de salvamento: evita salvar saídas idênticas muito recentes
        // MAS não aplica dedupe se a mensagem tem arquivo/anexo (fileId, audioId)
        // pois mesmo que o texto seja igual, são mensagens diferentes
        try {
            if (!fileId && !audioId && this.hasSimilarRecentOutgoing(chatId, text, 5000)) {
                return { id: messageId, direction: 'out', sender: 'bot', text, timestamp };
            }
        } catch (_) {}
        
        // Garante que o chat exista
        try { this.upsertChat(chatId); } catch (_) {}
        
        // Insere mensagem
        const normalizeValue = (value) => {
            if (value === undefined || value === null) return null;
            if (typeof value === 'object') {
                if (value._serialized) return value._serialized;
                if (value.id) return value.id;
                try { return JSON.stringify(value); } catch (_) { return String(value); }
            }
            return value;
        };

        const msgStmt = db.prepare(`
            INSERT INTO messages (id, chat_id, direction, content, timestamp, file_id, file_name, file_type, audio_id)
            VALUES (@id, @chat_id, @direction, @content, @timestamp, @file_id, @file_name, @file_type, @audio_id)
        `);
        msgStmt.run({
            id: messageId,
            chat_id: chatId,
            direction: 'out',
            content: text || '',
            timestamp,
            file_id: normalizeValue(fileId),
            file_name: normalizeValue(fileName),
            file_type: normalizeValue(fileType),
            audio_id: normalizeValue(audioId)
        });
        
        // Atualiza última mensagem e marca como mensagem do atendente apenas se for do atendente
        if (isAttendant) {
            const updateStmt = db.prepare(`
                UPDATE chats 
                SET last_message_at = datetime(?, 'unixepoch'),
                    last_attendant_message_at = ?,
                    updated_at = datetime('now')
                WHERE id = ?
            `);
            updateStmt.run(timestamp / 1000, timestamp, chatId);
        } else {
            const updateStmt = db.prepare(`
                UPDATE chats 
                SET last_message_at = datetime(?, 'unixepoch'),
                    updated_at = datetime('now')
                WHERE id = ?
            `);
            updateStmt.run(timestamp / 1000, chatId);
        }
        
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

    /**
     * Define se o bot está pausado para um chat específico
     */
    setBotPaused(chatId, paused) {
        try {
            const stmt = db.prepare(`
                UPDATE chats 
                SET bot_paused = ?, updated_at = datetime('now')
                WHERE id = ?
            `);
            stmt.run(paused ? 1 : 0, chatId);
            return true;
        } catch (e) {
            console.error('Erro ao definir estado de pausa do bot:', e);
            return false;
        }
    }

    /**
     * Verifica se o bot está pausado para um chat específico
     */
    isBotPaused(chatId) {
        try {
            const stmt = db.prepare('SELECT bot_paused FROM chats WHERE id = ?');
            const row = stmt.get(chatId);
            return row ? (row.bot_paused === 1) : false;
        } catch (e) {
            console.error('Erro ao verificar estado de pausa do bot:', e);
            return false;
        }
    }

    /**
     * Atualiza timestamp da última mensagem do atendente
     */
    updateLastAttendantMessage(chatId, timestamp) {
        try {
            const stmt = db.prepare(`
                UPDATE chats 
                SET last_attendant_message_at = ?, updated_at = datetime('now')
                WHERE id = ?
            `);
            stmt.run(timestamp, chatId);
            return true;
        } catch (e) {
            console.error('Erro ao atualizar última mensagem do atendente:', e);
            return false;
        }
    }

    /**
     * Obtém timestamp da última mensagem do atendente
     */
    getLastAttendantMessage(chatId) {
        try {
            const stmt = db.prepare('SELECT last_attendant_message_at FROM chats WHERE id = ?');
            const row = stmt.get(chatId);
            return row ? (row.last_attendant_message_at || null) : null;
        } catch (e) {
            console.error('Erro ao obter última mensagem do atendente:', e);
            return null;
        }
    }

    /**
     * Carrega todos os chats com bot pausado (para restaurar estado na inicialização)
     */
    getPausedChats() {
        try {
            const stmt = db.prepare('SELECT id FROM chats WHERE bot_paused = 1');
            const rows = stmt.all();
            return rows.map(row => row.id);
        } catch (e) {
            console.error('Erro ao obter chats pausados:', e);
            return [];
        }
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
                botPaused: row.bot_paused === 1,
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
                botPaused: chat.bot_paused === 1,
                lastAttendantMessageAt: chat.last_attendant_message_at || null,
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
     * Remove todos os chats e mensagens (limpeza total)
     */
    clearAll() {
        try {
            const tx = db.transaction(() => {
                db.exec('DELETE FROM messages;');
                db.exec('DELETE FROM chats;');
            });
            tx();
            try { db.exec('VACUUM;'); } catch (_) {}
            return true;
        } catch (e) {
            console.error('Erro ao limpar banco:', e);
            return false;
        }
    }

    /**
     * Verifica se já existe uma mensagem de saída recente com mesmo texto
     * para evitar duplicidade quando capturamos mensagens enviadas pelo WhatsApp.
     */
    hasSimilarRecentOutgoing(chatId, text, windowMs = 30000) {
        try {
            const threshold = Date.now() - windowMs;
            const trimmedText = (text || '').trim();
            
            if (!trimmedText) return false;
            
            // Verifica exatamente o texto (comparação exata)
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
            if (rowSimilar) return true;
            
            // Verifica mensagens muito recentes (últimos 5 segundos) com texto similar (primeiros 50 chars)
            const recentThreshold = Date.now() - 5000;
            if (trimmedText.length >= 10) {
                const prefix = trimmedText.substring(0, Math.min(50, trimmedText.length));
                const stmtRecent = db.prepare(`
                    SELECT 1 FROM messages
                    WHERE chat_id = ? AND direction = 'out' AND timestamp >= ?
                    AND LENGTH(content) >= 10
                    AND LOWER(SUBSTR(TRIM(content), 1, ?)) = LOWER(?)
                    LIMIT 1
                `);
                const rowRecent = stmtRecent.get(chatId, recentThreshold, prefix.length, prefix);
                if (rowRecent) return true;
            }
            
            return false;
        } catch (e) {
            // Em caso de erro, assume que não existe para evitar duplicatas
            return true;
        }
    }

    /**
     * Obtém estatísticas gerais do dashboard
     */
    getStats() {
        try {
            // Total de chats
            const totalChatsStmt = db.prepare('SELECT COUNT(*) as count FROM chats');
            const totalChats = totalChatsStmt.get().count;
            
            // Total de mensagens
            const totalMessagesStmt = db.prepare('SELECT COUNT(*) as count FROM messages');
            const totalMessages = totalMessagesStmt.get().count;
            
            // Total de não lidas
            const unreadStmt = db.prepare('SELECT SUM(unread_count) as total FROM chats');
            const unreadResult = unreadStmt.get();
            const totalUnread = unreadResult.total || 0;
            
            // Mensagens de entrada (clientes)
            const incomingStmt = db.prepare(`SELECT COUNT(*) as count FROM messages WHERE direction = 'in'`);
            const totalIncoming = incomingStmt.get().count;
            
            // Mensagens de saída (bot/atendente)
            const outgoingStmt = db.prepare(`SELECT COUNT(*) as count FROM messages WHERE direction = 'out'`);
            const totalOutgoing = outgoingStmt.get().count;
            
            // Chats ativos hoje
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const todayTimestamp = todayStart.getTime();
            const activeTodayStmt = db.prepare(`
                SELECT COUNT(DISTINCT chat_id) as count 
                FROM messages 
                WHERE timestamp >= ?
            `);
            const activeToday = activeTodayStmt.get(todayTimestamp).count;
            
            return {
                totalChats,
                totalMessages,
                totalUnread,
                totalIncoming,
                totalOutgoing,
                activeToday
            };
        } catch (e) {
            console.error('Erro ao obter estatísticas:', e);
            return {
                totalChats: 0,
                totalMessages: 0,
                totalUnread: 0,
                totalIncoming: 0,
                totalOutgoing: 0,
                activeToday: 0
            };
        }
    }
}

module.exports = new DatabaseStore();

