const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'panel.json');

function ensureDataDir() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (_) {}
}

function safeReadJson(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

function safeWriteJson(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (_) {}
}

class MessageStore {
    constructor() {
        ensureDataDir();
        this.chats = new Map();
        this.load();
    }

    load() {
        const data = safeReadJson(STORE_FILE);
        if (!data || !Array.isArray(data.chats)) return;
        for (const c of data.chats) {
            this.chats.set(c.id, {
                id: c.id,
                name: c.name || '',
                unreadCount: Number(c.unreadCount || 0),
                lastMessage: c.lastMessage || null,
                updatedAt: c.updatedAt || new Date().toISOString(),
                messages: Array.isArray(c.messages) ? c.messages : []
            });
        }
    }

    persist() {
        const chats = Array.from(this.chats.values()).map(c => ({
            id: c.id,
            name: c.name,
            unreadCount: c.unreadCount,
            lastMessage: c.lastMessage,
            updatedAt: c.updatedAt,
            messages: c.messages.slice(-500) // limita histórico por chat
        }));
        safeWriteJson(STORE_FILE, { chats });
    }

    upsertChat(chatId, name = '') {
        if (!this.chats.has(chatId)) {
            this.chats.set(chatId, {
                id: chatId,
                name,
                unreadCount: 0,
                lastMessage: null,
                updatedAt: new Date().toISOString(),
                messages: []
            });
        } else if (name && !this.chats.get(chatId).name) {
            this.chats.get(chatId).name = name;
        }
        return this.chats.get(chatId);
    }

    recordIncomingMessage({ chatId, sender, text, timestamp, name }) {
        const chat = this.upsertChat(chatId, name);
        const msg = {
            id: `${chatId}:${Date.now()}`,
            direction: 'in',
            sender,
            text: text || '',
            timestamp: timestamp || Date.now()
        };
        chat.messages.push(msg);
        chat.unreadCount += 1;
        chat.lastMessage = msg;
        chat.updatedAt = new Date().toISOString();
        this.persist();
        return msg;
    }

    recordOutgoingMessage({ chatId, text, timestamp }) {
        const chat = this.upsertChat(chatId);
        const msg = {
            id: `${chatId}:out:${Date.now()}`,
            direction: 'out',
            sender: 'bot',
            text: text || '',
            timestamp: timestamp || Date.now()
        };
        chat.messages.push(msg);
        chat.lastMessage = msg;
        chat.updatedAt = new Date().toISOString();
        // não mexe no unreadCount aqui (somente mensagens recebidas contam)
        this.persist();
        return msg;
    }

    markRead(chatId) {
        const chat = this.chats.get(chatId);
        if (!chat) return false;
        chat.unreadCount = 0;
        chat.updatedAt = new Date().toISOString();
        this.persist();
        return true;
    }

    listChats() {
        return Array.from(this.chats.values())
            .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
            .map(c => ({
                id: c.id,
                name: c.name,
                unreadCount: c.unreadCount,
                lastMessage: c.lastMessage,
                updatedAt: c.updatedAt
            }));
    }

    getChat(chatId) {
        const c = this.chats.get(chatId);
        if (!c) return null;
        return {
            id: c.id,
            name: c.name,
            unreadCount: c.unreadCount,
            lastMessage: c.lastMessage,
            updatedAt: c.updatedAt,
            messages: c.messages
        };
    }
}

module.exports = new MessageStore();



