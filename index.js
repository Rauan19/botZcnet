// LAZY LOADING: Carrega apenas o módulo necessário para economizar memória
// Se usar Baileys, não carrega whatsapp-web.js (Puppeteer/Chrome) que é pesado
let WhatsAppBot = null;
let BaileysBot = null;

// Função para carregar módulo sob demanda
function loadBotModule(provider) {
    if (provider === 'baileys') {
        if (!BaileysBot) {
            console.log('📦 Carregando módulo BaileysBot...');
            BaileysBot = require('./baileysBot');
        }
        return BaileysBot;
    } else {
        if (!WhatsAppBot) {
            console.log('📦 Carregando módulo WhatsAppBot (whatsapp-web.js)...');
            WhatsAppBot = require('./whatsappBot');
        }
        return WhatsAppBot;
    }
}

const zcBillService = require('./services/zcBillService');
const zcClientService = require('./services/zcClientService');
const express = require('express');
const path = require('path');
const messageStore = require('./database'); // Carrega e inicializa o banco
const multer = require('multer');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { convertToOpus, sendPTT } = require('./voice');

// Configuração de limpeza automática de arquivos PDF antigos
const CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutos

// Configuração de autenticação
// IMPORTANTE: Configure essas credenciais em variáveis de ambiente em produção
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@zcnet.com.br';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // Mude isso em produção!

// Secret para assinar tokens (use uma string aleatória forte em produção)
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'zcnet-secret-key-change-in-production';

// Gera token assinado que pode ser validado sem armazenar em memória
function generateToken(email) {
    const timestamp = Date.now();
    const expiresAt = timestamp + (24 * 60 * 60 * 1000); // 24 horas
    const payload = `${email}:${expiresAt}`;
    const signature = crypto.createHmac('sha256', TOKEN_SECRET)
        .update(payload)
        .digest('hex');
    return Buffer.from(`${payload}:${signature}`).toString('base64');
}

// Valida token sem precisar armazenar em memória
function validateToken(token) {
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const parts = decoded.split(':');
        
        if (parts.length !== 3) {
            return null;
        }
        
        const email = parts[0];
        const expiresAt = parseInt(parts[1]);
        const signature = parts[2];
        
        // Verifica se expirou
        if (Date.now() > expiresAt) {
            return null;
        }
        
        // Verifica assinatura
        const payload = `${email}:${expiresAt}`;
        const expectedSignature = crypto.createHmac('sha256', TOKEN_SECRET)
            .update(payload)
            .digest('hex');
        
        if (signature !== expectedSignature) {
            return null;
        }
        
        // Verifica se é o email admin
        if (email !== ADMIN_EMAIL) {
            return null;
        }
        
        return { email, expiresAt };
    } catch (e) {
        return null;
    }
}

// Middleware de autenticação
function authenticateToken(req, res, next) {
    // Rotas públicas não precisam de autenticação
    const publicRoutes = ['/api/auth/login', '/api/auth/verify', '/', '/api/test', '/api/session/qr', '/api/session/status', '/api/session/disconnect', '/favicon.ico'];
    
    // Debug: log da rota sendo acessada
    if (req.path.startsWith('/api/session')) {
        console.log(`🔍 Middleware: Rota acessada: ${req.path}, Método: ${req.method}`);
        console.log(`🔍 Middleware: É rota pública? ${publicRoutes.includes(req.path)}`);
    }
    
    if (publicRoutes.includes(req.path)) {
        return next();
    }
    
    // Rotas que aceitam token via query string OU header
    const tokenRoutes = ['/api/files', '/api/chats'];
    const isTokenRoute = tokenRoutes.some(route => req.path.startsWith(route));
    
    if (isTokenRoute) {
        // Para rotas de arquivos/áudios, permite passar via query string ou header
        // O endpoint específico irá validar o token
        return next();
    }
    
    // Para outras rotas, exige token válido no header
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Token não fornecido' });
    }
    
    const tokenData = validateToken(token);
    if (!tokenData) {
        return res.status(401).json({ error: 'Token inválido ou expirado' });
    }
    
    next();
}

class App {
    constructor() {
        this.provider = (process.env.WHATSAPP_PROVIDER || 'wweb').toLowerCase();
        this.usingBaileys = this.provider === 'baileys';
        this.port = process.env.PORT || 3009;
        
        // LAZY LOADING: Carrega apenas o módulo necessário
        const BotClass = loadBotModule(this.provider);
        this.bot = new BotClass();
        
        // Passa a porta para o bot se for Baileys
        if (this.usingBaileys && this.bot.setPort) {
            this.bot.setPort(this.port);
        }
        
        console.log(`🤖 Driver WhatsApp selecionado: ${this.usingBaileys ? 'Baileys (@whiskeysockets/baileys)' : 'whatsapp-web.js'}`);
        if (this.usingBaileys) {
            console.log('✅ Apenas Baileys carregado - whatsapp-web.js não foi carregado (economia de memória)');
        }
        
        this.setupDirectories(); // Cria diretórios necessários
        this.setupGracefulShutdown();
        this.setupCleanup();
        // Heartbeat para manter o event loop ativo e ajudar diagnósticos
        this.heartbeat = setInterval(() => {
            try {
                // noop + log ocasional
                if (Date.now() % (5 * 60 * 1000) < 1000) {
                    console.log('⏱️ Heartbeat ativo');
                }
            } catch {}
        }, 30 * 1000);
    }

    /**
     * Configura o encerramento graceful da aplicação
     */
    setupGracefulShutdown() {
        const shutdown = async (signal) => {
            // Encerrando aplicação
            
            try {
                await this.bot.stop();
                // Bot parado
                
                // Limpa arquivos temporários
                zcBillService.cleanupOldPDFs(0); // Remove todos os arquivos
                // Limpeza concluída
                
                process.exit(0);
            } catch (error) {
                
                process.exit(1);
            }
        };

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    }

    /**
     * Cria diretórios necessários na inicialização
     */
    setupDirectories() {
        const directories = [
            path.join(__dirname, 'audios'),
            path.join(__dirname, 'files'),
            path.join(__dirname, 'temp_audio'),
            path.join(__dirname, 'avatars')
        ];
        
        directories.forEach(dir => {
            try {
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                    console.log(`✅ Diretório criado: ${dir}`);
                }
            } catch (e) {
                console.error(`❌ Erro ao criar diretório ${dir}:`, e);
            }
        });
    }

    /**
     * Configura limpeza automática de arquivos PDF antigos
     */
    setupCleanup() {
        setInterval(() => {
            try {
                zcBillService.cleanupOldPDFs();
            } catch (error) {
                console.error('❌ Erro na limpeza automática:', error);
            }
        }, CLEANUP_INTERVAL);
    }

    /**
     * Inicia a aplicação
     */
    async start() {
        try {
            // Inicia painel web
            this.startDashboard();
            // Atualiza porta do bot após iniciar dashboard (porta pode ser definida no startDashboard)
            if (this.usingBaileys && this.bot.setPort) {
                const dashboardPort = process.env.PORT || 3009;
                this.bot.setPort(dashboardPort);
            }
            // Inicia o bot diretamente
            await this.bot.start();

        } catch (error) {
            console.error('❌ Erro fatal ao iniciar:', error);
            // Não sair imediatamente; aguardar watchdog do bot tentar reinício
        }
    }

    startDashboard() {
        try {
            const app = express();
            const PORT = process.env.PORT || 3009;
            app.use(express.json());
            
            console.log('🚀 Iniciando dashboard e registrando rotas...');
            
            // Guarda referência para usar nas rotas (this não funciona dentro das callbacks do Express)
            const self = this;
            
            // Rotas públicas PRIMEIRO (antes do middleware de autenticação)
            // API: Login (pública)
            app.post('/api/auth/login', (req, res) => {
                try {
                    const { email, password } = req.body;
                    
                    if (!email || !password) {
                        return res.status(400).json({ error: 'Email e senha são obrigatórios' });
                    }
                    
                    // Verifica credenciais
                    if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
                        const token = generateToken(email);
                        
                        console.log(`✅ Login realizado: ${email}`);
                        return res.json({ token, email });
                    } else {
                        console.log(`❌ Tentativa de login falhou: ${email}`);
                        return res.status(401).json({ error: 'Email ou senha incorretos' });
                    }
                } catch (e) {
                    console.error('❌ Erro no login:', e);
                    return res.status(500).json({ error: 'Erro interno do servidor' });
                }
            });
            
            // API: Verificar token
            app.get('/api/auth/verify', (req, res) => {
                const authHeader = req.headers['authorization'];
                const token = authHeader && authHeader.split(' ')[1];
                
                if (!token) {
                    return res.status(401).json({ error: 'Token não fornecido' });
                }
                
                const tokenData = validateToken(token);
                if (!tokenData) {
                    return res.status(401).json({ error: 'Token inválido ou expirado' });
                }
                
                res.json({ valid: true });
            });
            
            // Diretório de arquivos (PDFs, etc.)
            const filesDir = path.join(__dirname, 'files');
            if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
            // Endpoint para baixar/abrir arquivos por ID
            // Aceita token via query string ou header Authorization
            app.get('/api/files/:id', (req, res) => {
                try {
                    // Verifica token via query string ou header
                    let token = req.query.token || (req.headers['authorization'] && req.headers['authorization'].split(' ')[1]);
                    
                    // Decodifica o token se vier via query string (pode estar URL-encoded)
                    if (token && req.query.token) {
                        try {
                            token = decodeURIComponent(token);
                        } catch (e) {
                            // Se falhar ao decodificar, usa o token original
                        }
                    }
                    
                    // Se token está vazio (string vazia), também considera como não fornecido
                    if (!token || token.trim() === '') {
                        console.log('❌ Token não fornecido para arquivo:', req.params.id);
                        return res.status(401).json({ error: 'Token não fornecido' });
                    }
                    
                    const tokenData = validateToken(token);
                    if (!tokenData) {
                        console.log('❌ Token inválido ou expirado para arquivo:', req.params.id);
                        return res.status(401).json({ error: 'Token inválido ou expirado' });
                    }
                    
                    const id = req.params.id;
                    const filePath = path.join(filesDir, id);
                    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not_found' });
                    
                    // Detecta tipo de arquivo pela extensão
                    const ext = path.extname(filePath).toLowerCase();
                    let contentType = 'application/octet-stream';
                    
                    if (ext === '.pdf') {
                        contentType = 'application/pdf';
                        // Permite visualização inline no navegador
                        res.setHeader('Content-Type', contentType);
                        res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
                    } else if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif') {
                        contentType = `image/${ext.slice(1)}`;
                        res.setHeader('Content-Type', contentType);
                    }
                    
                    res.sendFile(filePath);
                } catch (e) {
                    console.error('❌ Erro ao servir arquivo:', e);
                    res.status(500).json({ error: 'internal_error' });
                }
            });
            
            // Configuração do multer para upload de áudio, imagens e arquivos
            const uploadDir = path.join(__dirname, 'temp_audio');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            
            const upload = multer({
                dest: uploadDir,
                limits: { fileSize: 16 * 1024 * 1024 } // 16MB
            });
            
            const uploadImage = multer({
                dest: uploadDir,
                limits: { fileSize: 16 * 1024 * 1024 }, // 16MB
                fileFilter: (req, file, cb) => {
                    // Aceita apenas imagens
                    if (file.mimetype.startsWith('image/')) {
                        cb(null, true);
                    } else {
                        cb(new Error('Apenas imagens são permitidas'));
                    }
                }
            });
            
            const uploadFile = multer({
                dest: uploadDir,
                limits: { fileSize: 16 * 1024 * 1024 } // 16MB
            });

            // API: estatísticas do dashboard
            app.get('/api/stats', (req, res) => {
                try {
                    const stats = messageStore.getStats();
                    res.json(stats);
                } catch (e) {
                    res.status(500).json({ error: 'internal_error' });
                }
            });

            // API: limpar todas as conversas e mensagens
            app.post('/api/chats/clear', (req, res) => {
                try {
                    const ok = messageStore.clearAll();
                    if (!ok) return res.status(500).json({ ok: false });
                    res.json({ ok: true });
                } catch (e) {
                    res.status(500).json({ ok: false });
                }
            });

            // API: lista de chats
            app.get('/api/chats', (req, res) => {
                try {
                    const chats = messageStore.listChats();
                    res.json({ chats });
                } catch (e) {
                    res.status(500).json({ error: 'internal_error' });
                }
            });

            // API: detalhes do chat e mensagens
            app.get('/api/chats/:id', (req, res) => {
                try {
                    const chat = messageStore.getChat(req.params.id);
                    if (!chat) return res.status(404).json({ error: 'not_found' });
                    res.json(chat);
                } catch (e) {
                    res.status(500).json({ error: 'internal_error' });
                }
            });

            // API: marcar como lido (zera contador do painel)
            app.post('/api/chats/:id/mark-read', (req, res) => {
                try {
                    const ok = messageStore.markRead(req.params.id);
                    res.json({ ok });
                } catch (e) {
                    res.status(500).json({ error: 'internal_error' });
                }
            });

            // API: verificar status do bot para um chat
            app.get('/api/chats/:id/bot-status', (req, res) => {
                try {
                    const chatId = req.params.id;
                    const isPaused = this.bot.isBotPausedForChat(chatId);
                    res.json({ paused: isPaused });
                } catch (e) {
                    res.status(500).json({ error: 'internal_error' });
                }
            });

            // API: alternar bot (ativar/desativar)
            app.post('/api/chats/:id/toggle-bot', (req, res) => {
                try {
                    const chatId = req.params.id;
                    const isPaused = this.bot.isBotPausedForChat(chatId);
                    
                    if (isPaused) {
                        // Reativa o bot
                        this.bot.reactivateBotForChat(chatId);
                        // Salva no banco
                        messageStore.setBotPaused(chatId, false);
                        res.json({ ok: true, paused: false, message: 'Bot reativado' });
                    } else {
                        // Pausa o bot
                        this.bot.pauseBotForChat(chatId);
                        // Salva no banco
                        messageStore.setBotPaused(chatId, true);
                        res.json({ ok: true, paused: true, message: 'Bot pausado' });
                    }
                } catch (e) {
                    res.status(500).json({ error: 'internal_error' });
                }
            });

            // API: finalizar atendimento (reativa bot) - mantido para compatibilidade
            app.post('/api/chats/:id/end-attendant', (req, res) => {
                try {
                    const chatId = req.params.id;
                    // Verifica se bot tem método reactivateBotForChat (pode não existir no Baileys)
                    if (this.bot.reactivateBotForChat) {
                        this.bot.reactivateBotForChat(chatId);
                        messageStore.setBotPaused(chatId, false);
                    }
                    res.json({ ok: true });
                } catch (e) {
                    res.status(500).json({ error: 'internal_error' });
                }
            });

            // API: limpar contexto de um chat específico (manual)
            app.post('/api/chats/:id/clear-context', (req, res) => {
                try {
                    const chatId = req.params.id;
                    if (this.bot.clearContextForChat) {
                        const result = this.bot.clearContextForChat(chatId);
                        res.json({ ok: true, ...result });
                    } else {
                        res.json({ ok: true, message: 'Método não disponível neste driver' });
                    }
                } catch (e) {
                    res.status(500).json({ error: e.message || 'internal_error' });
                }
            });

            // API: limpar todos os contextos (útil para testes)
            app.post('/api/chats/clear-all-contexts', (req, res) => {
                try {
                    if (this.bot.clearAllContexts) {
                        const result = this.bot.clearAllContexts();
                        res.json({ ok: true, ...result });
                    } else {
                        res.json({ ok: true, message: 'Método não disponível neste driver' });
                    }
                } catch (e) {
                    res.status(500).json({ error: e.message || 'internal_error' });
                }
            });

            // API: enviar mensagem
            app.post('/api/chats/:id/send', async (req, res) => {
                try {
                    const chatId = req.params.id;
                    const { text } = req.body;

                    if (!text || !text.trim()) {
                        return res.status(400).json({ error: 'Mensagem não pode estar vazia' });
                    }

                    // IMPORTANTE: Marca bot como pausado quando atendente envia pelo painel
                    // Isso evita que bot responda enquanto atendente está conversando
                    const wasPaused = this.bot.isBotPausedForChat(chatId);
                    if (!wasPaused) {
                        // Pausa bot para este chat
                        this.bot.pauseBotForChat(chatId);
                        // Salva no banco
                        messageStore.setBotPaused(chatId, true);
                        console.log(`⏸️ Bot pausado automaticamente para ${chatId} (atendente enviou mensagem)`);
                    }
                    
                    // Atualiza timestamp da última mensagem do atendente
                    const timestamp = Date.now();
                    messageStore.updateLastAttendantMessage(chatId, timestamp);

                    // Envia mensagem pelo bot
                    // O sendMessage agora salva no banco ANTES de enviar
                    const result = await this.bot.sendMessage(chatId, text.trim());
                    
                    // Salva mensagem como do atendente
                    try {
                        messageStore.recordOutgoingMessage({
                            chatId: chatId,
                            text: text.trim(),
                            timestamp: timestamp,
                            isAttendant: true
                        });
                    } catch (saveError) {
                        // Ignora erro ao salvar
                    }

                    // Retorna sucesso mesmo se o envio falhar (mensagem já está salva no banco)
                    res.json({ ok: true, messageId: result?.id || null, saved: true });
                } catch (e) {
                    console.error('❌ Erro ao enviar mensagem:', e);
                    // Mesmo com erro, tenta salvar a mensagem no banco para aparecer no painel
                    try {
                        messageStore.recordOutgoingMessage({
                            chatId: chatId,
                            text: text.trim(),
                            timestamp: Date.now(),
                            isAttendant: true
                        });
                    } catch (saveError) {
                        // Ignora erro ao salvar
                    }
                    res.status(500).json({ error: e.message || 'internal_error' });
                }
            });

            // API: baixar áudio
            // Aceita token via query string ou header Authorization
            app.get('/api/chats/:chatId/audio/:audioId', (req, res) => {
                try {
                    // Verifica token via query string ou header
                    let token = req.query.token || (req.headers['authorization'] && req.headers['authorization'].split(' ')[1]);
                    
                    // Decodifica o token se vier via query string (pode estar URL-encoded)
                    if (token && req.query.token) {
                        try {
                            token = decodeURIComponent(token);
                        } catch (e) {
                            // Se falhar ao decodificar, usa o token original
                        }
                    }
                    
                    // Se token está vazio (string vazia), também considera como não fornecido
                    if (!token || token.trim() === '') {
                        console.log('❌ Token não fornecido para áudio:', req.params.audioId);
                        return res.status(401).json({ error: 'Token não fornecido' });
                    }
                    
                    const tokenData = validateToken(token);
                    if (!tokenData) {
                        console.log('❌ Token inválido ou expirado para áudio:', req.params.audioId);
                        return res.status(401).json({ error: 'Token inválido ou expirado' });
                    }
                    
                    const { audioId } = req.params;
                    
                    // Garante que o diretório existe
                    const audioDir = path.join(__dirname, 'audios');
                    if (!fs.existsSync(audioDir)) {
                        fs.mkdirSync(audioDir, { recursive: true });
                    }
                    
                    // Busca o arquivo salvo
                    const audioPath = path.join(audioDir, `${audioId}.ogg`);
                    
                    console.log(`🔍 Buscando áudio: ${audioPath}`);
                    
                    if (!fs.existsSync(audioPath)) {
                        console.error(`❌ Áudio não encontrado: ${audioPath}`);
                        return res.status(404).json({ error: 'Áudio não encontrado', audioId, path: audioPath });
                    }
                    
                    // Verifica se é arquivo válido
                    const stats = fs.statSync(audioPath);
                    if (stats.size === 0) {
                        console.error(`❌ Áudio vazio: ${audioPath}`);
                        return res.status(404).json({ error: 'Áudio vazio' });
                    }
                    
                    res.setHeader('Content-Type', 'audio/ogg; codecs=opus');
                    res.setHeader('Content-Length', stats.size);
                    res.setHeader('Cache-Control', 'public, max-age=3600');
                    res.sendFile(audioPath);
                } catch (e) {
                    console.error('❌ Erro ao baixar áudio:', e);
                    res.status(500).json({ error: e.message || 'Erro ao baixar áudio', details: e.toString() });
                }
            });

            // API: enviar áudio
            app.post('/api/chats/:id/send-audio', upload.single('audio'), async (req, res) => {
                try {
                    const chatId = req.params.id;
                    const file = req.file;

                    if (!file) {
                        console.warn(`[send-audio] Nenhum arquivo recebido para ${chatId}`);
                        return res.status(400).json({ error: 'Nenhum arquivo enviado' });
                    }

                    console.log(`[send-audio] Iniciando envio para ${chatId}. Arquivo: ${file.originalname} (${file.mimetype}, ${file.size} bytes)`);

                    // IMPORTANTE: Marca bot como pausado quando atendente envia áudio pelo painel
                    const wasPaused = this.bot.isBotPausedForChat(chatId);
                    if (!wasPaused) {
                        this.bot.pauseBotForChat(chatId);
                        messageStore.setBotPaused(chatId, true);
                        console.log(`⏸️ Bot pausado automaticamente para ${chatId} (atendente enviou áudio)`);
                    }
                    
                    // Atualiza timestamp da última mensagem do atendente
                    const timestamp = Date.now();
                    messageStore.updateLastAttendantMessage(chatId, timestamp);

                    const clientInstance = this.bot.client;
                    if (!this.usingBaileys && !clientInstance) {
                        console.error('[send-audio] Bot não conectado');
                        return res.status(503).json({ error: 'Bot não conectado' });
                    }

                    const tempDir = path.join(__dirname, 'temp_audio');
                    if (!fs.existsSync(tempDir)) {
                        fs.mkdirSync(tempDir, { recursive: true });
                    }

                    const convertedPath = path.join(
                        tempDir,
                        `voz_${Date.now()}_${Math.random().toString(36).slice(2)}.ogg`
                    );

                    console.log(`[send-audio] Arquivo temporário: ${file.path}. Converter para ${convertedPath}`);

                    const originalExt = path.extname(file.originalname || '');
                    const mimeExtMap = {
                        'audio/webm': '.webm',
                        'audio/ogg': '.ogg',
                        'audio/mpeg': '.mp3',
                        'audio/mp3': '.mp3',
                        'audio/wav': '.wav',
                        'audio/x-wav': '.wav',
                        'audio/aac': '.aac',
                        'audio/m4a': '.m4a',
                        'audio/x-m4a': '.m4a',
                        'audio/3gpp': '.3gp'
                    };
                    const inferredExt = mimeExtMap[file.mimetype] || originalExt || '.webm';
                    let sourcePath = file.path;
                    let renamedSource = false;
                    if (!path.extname(file.path)) {
                        sourcePath = `${file.path}${inferredExt}`;
                        try {
                            fs.renameSync(file.path, sourcePath);
                            renamedSource = true;
                            console.log(`[send-audio] Renomeado arquivo temporário para ${sourcePath}`);
                        } catch (renameErr) {
                            console.warn('⚠️ Não foi possível renomear arquivo temporário:', renameErr);
                            sourcePath = file.path;
                        }
                    }

                    const validMagicBytes = ['\x52\x49\x46\x46', 'OggS', '\x1A\x45\xDF\xA3'];
                    const header = Buffer.alloc(4);
                    const fd = fs.openSync(sourcePath, 'r');
                    fs.readSync(fd, header, 0, 4, 0);
                    fs.closeSync(fd);
                    const headerStr = header.toString('latin1');
                    const isValidHeader = validMagicBytes.some((magic) => headerStr.startsWith(magic));
                    if (!isValidHeader) {
                        console.error('[send-audio] Arquivo inválido (magic bytes não reconhecidos)');
                        throw new Error('Arquivo enviado não é um áudio válido ou está corrompido');
                    }

                    try {
                        console.log('[send-audio] Iniciando conversão para Opus...');
                        await convertToOpus(sourcePath, convertedPath);
                        console.log('[send-audio] Conversão concluída');
                    } catch (conversionError) {
                        console.error('❌ Erro ao converter áudio para Opus:', conversionError);
                        if (fs.existsSync(convertedPath)) {
                            fs.unlinkSync(convertedPath);
                        }
                        if (renamedSource && fs.existsSync(sourcePath)) {
                            fs.unlinkSync(sourcePath);
                        }
                        throw conversionError;
                    }

                    let sendResult = null;
                    if (this.usingBaileys) {
                        console.log('[send-audio] Enviando diretamente via Baileys...');
                        sendResult = await this.bot.sendAudio(chatId, convertedPath, 'audio.ogg');
                    } else {
                        console.log('[send-audio] Chamando sendPTT (whatsapp-web.js)...');
                        await sendPTT(clientInstance, chatId, convertedPath);
                        console.log('[send-audio] sendPTT concluído');
                    }
                    
                    // Salva o áudio para playback futuro
                    const audioId = sendResult?.key?.id || `audio_${Date.now()}`;
                    const audioData = fs.readFileSync(convertedPath);
                    const audioDir = path.join(__dirname, 'audios');
                    if (!fs.existsSync(audioDir)) {
                        fs.mkdirSync(audioDir, { recursive: true });
                    }
                    const audioPath = path.join(audioDir, `${audioId}.ogg`);
                    fs.writeFileSync(audioPath, audioData);
                    
                    // Registra mensagem enviada com o ID do áudio (como do atendente)
                    messageStore.recordOutgoingMessage({
                        chatId: chatId,
                        text: '[áudio]',
                        timestamp: timestamp,
                        audioId: audioId,
                        isAttendant: true
                    });
                    
                    // Remove arquivo temporário
                    try {
                        if (fs.existsSync(convertedPath)) fs.unlinkSync(convertedPath);
                        if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
                    } catch (e) {}

                    console.log(`[send-audio] Finalizado com sucesso para ${chatId}, audioId=${audioId}`);
                    res.json({ ok: true, messageId: audioId });
                } catch (e) {
                    console.error('❌ Erro ao enviar áudio:', e);
                    res.status(500).json({ error: e.message || 'internal_error' });
                }
            });

            // API: enviar imagem
            app.post('/api/chats/:id/send-image', uploadImage.single('image'), async (req, res) => {
                try {
                    const chatId = req.params.id;
                    const file = req.file;

                    if (!file) {
                        return res.status(400).json({ error: 'Nenhuma imagem enviada' });
                    }

                    // IMPORTANTE: Marca bot como pausado quando atendente envia imagem pelo painel
                    const wasPaused = this.bot.isBotPausedForChat(chatId);
                    if (!wasPaused) {
                        this.bot.pauseBotForChat(chatId);
                        messageStore.setBotPaused(chatId, true);
                        console.log(`⏸️ Bot pausado automaticamente para ${chatId} (atendente enviou imagem)`);
                    }
                    
                    // Atualiza timestamp da última mensagem do atendente
                    const timestamp = Date.now();
                    messageStore.updateLastAttendantMessage(chatId, timestamp);

                    // Determina extensão do arquivo
                    const ext = path.extname(file.originalname || '') || '.jpg';
                    const fileName = `imagem_${Date.now()}${ext}`;
                    const finalPath = path.join(uploadDir, fileName);
                    
                    // Move arquivo para nome final
                    fs.renameSync(file.path, finalPath);

                    // Salva a imagem para exibição no painel ANTES de enviar
                    const filesDir = path.join(__dirname, 'files');
                    if (!fs.existsSync(filesDir)) {
                        fs.mkdirSync(filesDir, { recursive: true });
                    }
                    const fileId = `imagem_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
                    const destPath = path.join(filesDir, fileId);
                    
                    // Copia arquivo ANTES de enviar e salvar no banco
                    fs.copyFileSync(finalPath, destPath);
                    
                    // Verifica se arquivo foi copiado corretamente
                    if (!fs.existsSync(destPath)) {
                        throw new Error('Erro ao copiar arquivo para diretório files');
                    }
                    
                    // Registra mensagem no banco ANTES de enviar (para garantir que aparece no painel)
                    const fileMimetype = file.mimetype || 'image/jpeg';
                    console.log('📸 Salvando imagem no banco:', {
                        chatId,
                        fileId,
                        fileName,
                        fileType: fileMimetype,
                        timestamp,
                        fileExists: fs.existsSync(destPath)
                    });
                    
                    messageStore.recordOutgoingMessage({
                        chatId: chatId,
                        text: '[imagem]',
                        timestamp: timestamp,
                        fileId: fileId,
                        fileName: fileName,
                        fileType: fileMimetype,
                        isAttendant: true
                    });
                    
                    console.log('✅ Imagem salva no banco com sucesso');
                    
                    // Envia imagem pelo bot DEPOIS de salvar no banco
                    await this.bot.sendKeepingUnread(
                        () => this.bot.sendFile(chatId, finalPath, fileName, ''),
                        chatId,
                        null // já registramos no banco acima
                    );
                    
                    // Remove arquivo temporário
                    try {
                        if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
                    } catch (e) {}

                    res.json({ ok: true });
                } catch (e) {
                    console.error('❌ Erro ao enviar imagem:', e);
                    res.status(500).json({ error: e.message || 'internal_error' });
                }
            });

            // API: enviar arquivo
            app.post('/api/chats/:id/send-file', uploadFile.single('file'), async (req, res) => {
                try {
                    const chatId = req.params.id;
                    const file = req.file;

                    if (!file) {
                        return res.status(400).json({ error: 'Nenhum arquivo enviado' });
                    }

                    // IMPORTANTE: Marca bot como pausado quando atendente envia arquivo pelo painel
                    const wasPaused = this.bot.isBotPausedForChat(chatId);
                    if (!wasPaused) {
                        this.bot.pauseBotForChat(chatId);
                        messageStore.setBotPaused(chatId, true);
                        console.log(`⏸️ Bot pausado automaticamente para ${chatId} (atendente enviou arquivo)`);
                    }
                    
                    // Atualiza timestamp da última mensagem do atendente
                    const timestamp = Date.now();
                    messageStore.updateLastAttendantMessage(chatId, timestamp);

                    // Usa nome original do arquivo ou gera um
                    const fileName = file.originalname || `arquivo_${Date.now()}`;
                    const finalPath = path.join(uploadDir, fileName);
                    
                    // Move arquivo para nome final
                    fs.renameSync(file.path, finalPath);

                    // Envia arquivo pelo bot
                    await this.bot.sendKeepingUnread(
                        () => this.bot.sendFile(chatId, finalPath, fileName, ''),
                        chatId,
                        null // mensagem já registrada acima
                    );
                    
                    // Salva o arquivo para exibição no painel
                    const filesDir = path.join(__dirname, 'files');
                    if (!fs.existsSync(filesDir)) {
                        fs.mkdirSync(filesDir, { recursive: true });
                    }
                    const fileId = `arquivo_${Date.now()}_${Math.random().toString(36).slice(2)}_${fileName}`;
                    const destPath = path.join(filesDir, fileId);
                    fs.copyFileSync(finalPath, destPath);
                    
                    // Registra mensagem enviada com o ID do arquivo (como do atendente)
                    messageStore.recordOutgoingMessage({
                        chatId: chatId,
                        text: '[arquivo]',
                        timestamp: timestamp,
                        fileId: fileId,
                        fileName: fileName,
                        fileType: file.mimetype || 'application/octet-stream',
                        isAttendant: true
                    });
                    
                    // Remove arquivo temporário
                    try {
                        if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
                    } catch (e) {}

                    res.json({ ok: true });
                } catch (e) {
                    console.error('❌ Erro ao enviar arquivo:', e);
                    res.status(500).json({ error: e.message || 'internal_error' });
                }
            });

            // API: foto de perfil do chat (com cache local)
            app.get('/api/chats/:id/photo', async (req, res) => {
                try {
                    const chatId = req.params.id;
                    const avatarsDir = path.join(__dirname, 'avatars');
                    if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });
                    const cachePath = path.join(avatarsDir, encodeURIComponent(chatId) + '.jpg');

                    // Usa cache por 24h
                    const ONE_DAY = 24 * 60 * 60 * 1000;
                    if (fs.existsSync(cachePath)) {
                        const stat = fs.statSync(cachePath);
                        if (Date.now() - stat.mtimeMs < ONE_DAY) {
                            res.setHeader('Cache-Control', 'public, max-age=3600');
                            return res.sendFile(cachePath);
                        }
                    }

                    // Pede URL ao bot
                    const url = await this.bot.getProfilePicUrl(chatId);
                    if (!url || !/^https?:\/\//i.test(String(url))) {
                        // Fallback: gera avatar SVG com iniciais
                        try {
                            const chat = messageStore.getChat(chatId);
                            const name = (chat && chat.name) ? String(chat.name) : String(chatId);
                            const initials = name
                                .split(/\s+/)
                                .filter(Boolean)
                                .map(n => n[0])
                                .join('')
                                .substring(0, 2)
                                .toUpperCase();
                            const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#3b82f6"/>
      <stop offset="100%" stop-color="#8b5cf6"/>
    </linearGradient>
  </defs>
  <rect width="96" height="96" rx="48" fill="url(#g)"/>
  <text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" 
        font-family="Segoe UI, Roboto, sans-serif" font-size="36" font-weight="700" fill="#ffffff">${initials}</text>
  </svg>`;
                            res.setHeader('Content-Type', 'image/svg+xml');
                            res.setHeader('Cache-Control', 'public, max-age=600');
                            return res.send(svg);
                        } catch (e) {
                            return res.status(404).json({ error: 'no_photo' });
                        }
                    }

                    // Baixa via HTTPS e salva em cache
                    const fileStream = fs.createWriteStream(cachePath);
                    https.get(url, (resp) => {
                        if (resp.statusCode !== 200) {
                            try { fs.existsSync(cachePath) && fs.unlinkSync(cachePath); } catch (_) {}
                            return res.status(404).json({ error: 'not_found' });
                        }
                        resp.pipe(fileStream);
                        fileStream.on('finish', () => {
                            fileStream.close(() => {
                                res.setHeader('Cache-Control', 'public, max-age=3600');
                                return res.sendFile(cachePath);
                            });
                        });
                    }).on('error', (err) => {
                        try { fs.existsSync(cachePath) && fs.unlinkSync(cachePath); } catch (_) {}
                        return res.status(500).json({ error: 'internal_error' });
                    });
                } catch (e) {
                    return res.status(500).json({ error: 'internal_error' });
                }
            });

            // Dashboard estático
            app.get('/', (req, res) => {
                res.sendFile(path.join(__dirname, 'dashboard.html'));
            });

            // Rotas públicas de sessão (ANTES de qualquer middleware)
            console.log('📝 Registrando rotas públicas de sessão...');
            
            // Teste simples
            app.get('/api/test', (req, res) => {
                console.log('✅ Rota /api/test acessada');
                return res.json({ message: 'Rota de teste funcionando!' });
            });

            // QR Code atual (se disponível)
            app.get('/api/session/qr', async (req, res) => {
                console.log('📱 ROTA /api/session/qr ACESSADA - Requisição recebida');
                console.log('📱 Método:', req.method, 'Path:', req.path, 'URL:', req.url);
                try {
                    console.log('📱 Processando requisição para /api/session/qr');
                    if (!self.bot) {
                        console.log('⚠️ Bot não disponível');
                        return res.status(503).json({ error: 'unavailable', message: 'Bot não disponível' });
                    }
                    if (typeof self.bot.getLastQr !== 'function') {
                        console.log('⚠️ Método getLastQr não disponível');
                        return res.status(503).json({ error: 'unavailable', message: 'Bot não disponível' });
                    }
                    const qr = await self.bot.getLastQr();
                    if (!qr) {
                        // Verifica se está conectado
                        const isConnected = self.bot.started && self.bot.sock?.user;
                        if (isConnected) {
                            return res.status(200).json({ 
                                error: 'no_qr', 
                                message: 'Bot já está conectado. Para gerar novo QR, desconecte primeiro.',
                                connected: true
                            });
                        }
                        
                        // Verifica se há erro de conexão (405, 408, etc)
                        const hasConnectionError = self.bot.lastConnectionError;
                        if (hasConnectionError) {
                            return res.status(200).json({ 
                                error: 'connection_error', 
                                message: `Erro ao conectar com WhatsApp (código: ${hasConnectionError}). O QR code não pode ser gerado. Verifique os logs do servidor para mais detalhes.`,
                                connected: false,
                                errorCode: hasConnectionError,
                                suggestion: 'Aguarde alguns minutos e tente novamente. Se persistir, limpe os tokens e reinicie o bot.'
                            });
                        }
                        
                        // Verifica se está tentando conectar
                        const isConnecting = self.bot.started && !isConnected;
                        return res.status(200).json({ 
                            error: 'no_qr', 
                            message: isConnecting 
                                ? 'QR code ainda não foi gerado. O bot está tentando conectar... Aguarde alguns segundos e tente novamente.'
                                : 'QR code ainda não foi gerado. Aguarde alguns segundos e tente novamente.',
                            connected: false,
                            connecting: isConnecting
                        });
                    }
                    console.log('✅ QR code encontrado, enviando...');
                    res.setHeader('Content-Type', qr.contentType || 'image/png');
                    return res.send(qr.buffer);
                } catch (e) {
                    console.error('❌ Erro ao obter QR:', e);
                    return res.status(500).json({ error: 'internal_error', message: e.message });
                }
            });

            // Endpoint para verificar status da conexão
            app.get('/api/session/status', async (req, res) => {
                try {
                    if (!self.bot) {
                        return res.json({ 
                            connected: false, 
                            started: false, 
                            message: 'Bot não inicializado' 
                        });
                    }
                    const isConnected = self.bot.started && self.bot.sock?.user;
                    const hasQr = !!self.bot.qrString;
                    const isInitialized = self.bot.initialized || self.bot.started;
                    const lastError = self.bot.lastConnectionError;
                    
                    let message = 'Aguardando QR code...';
                    if (isConnected) {
                        message = 'Bot conectado e funcionando';
                    } else if (hasQr) {
                        message = 'QR code disponível. Escaneie para conectar.';
                    } else if (lastError) {
                        message = `Erro de conexão (código: ${lastError}). QR code não pode ser gerado.`;
                    } else if (isInitialized) {
                        message = 'Bot inicializado. Aguardando QR code...';
                    } else {
                        message = 'Bot não inicializado ainda. Aguarde...';
                    }
                    
                    return res.json({
                        connected: isConnected,
                        started: self.bot.started,
                        initialized: isInitialized,
                        hasQr: hasQr,
                        userId: self.bot.sock?.user?.id || null,
                        lastError: lastError,
                        message: message
                    });
                } catch (e) {
                    return res.status(500).json({ error: 'internal_error', message: e.message });
                }
            });

            // Endpoint para forçar desconexão e gerar novo QR
            app.post('/api/session/disconnect', async (req, res) => {
                try {
                    if (!self.bot) {
                        return res.status(503).json({ error: 'unavailable', message: 'Bot não disponível' });
                    }
                    
                    console.log('🔄 Desconectando bot para gerar novo QR...');
                    await self.bot.stop();
                    
                    // Limpa tokens para forçar novo QR
                    if (self.bot.cleanupAuthDir) {
                        self.bot.cleanupAuthDir();
                    }
                    
                    // Aguarda um pouco antes de reiniciar
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                    // Reinicia o bot (vai gerar novo QR)
                    await self.bot.start();
                    
                    return res.json({ 
                        success: true, 
                        message: 'Bot desconectado. Novo QR code será gerado em alguns segundos.',
                        qrUrl: '/api/session/qr'
                    });
                } catch (e) {
                    console.error('❌ Erro ao desconectar:', e);
                    return res.status(500).json({ error: 'internal_error', message: e.message });
                }
            });

            // Aplica middleware de autenticação APÓS todas as rotas públicas
            app.use(authenticateToken);

            // API: reconectar websocket
            app.post('/api/websocket/reconnect', async (req, res) => {
                try {
                    const result = await this.bot.reconnect();
                    if (result.success) {
                        return res.json({ 
                            ok: true, 
                            message: result.message,
                            reconnected: result.reconnected 
                        });
                    } else {
                        return res.status(500).json({ 
                            ok: false, 
                            error: result.message || 'Falha ao reconectar' 
                        });
                    }
                } catch (e) {
                    console.error('❌ Erro ao reconectar websocket:', e);
                    return res.status(500).json({ error: 'internal_error', message: e.message });
                }
            });

            // API: pausar websocket
            app.post('/api/websocket/pause', async (req, res) => {
                try {
                    const result = await this.bot.pause();
                    if (result.success) {
                        return res.json({ ok: true, message: result.message });
                    } else {
                        return res.status(500).json({ ok: false, error: result.message || 'Falha ao pausar' });
                    }
                } catch (e) {
                    console.error('❌ Erro ao pausar websocket:', e);
                    return res.status(500).json({ error: 'internal_error', message: e.message });
                }
            });

            // API: retomar websocket
            app.post('/api/websocket/resume', async (req, res) => {
                try {
                    const result = await this.bot.resume();
                    if (result.success) {
                        return res.json({ ok: true, message: result.message });
                    } else {
                        return res.status(500).json({ ok: false, error: result.message || 'Falha ao retomar' });
                    }
                } catch (e) {
                    console.error('❌ Erro ao retomar websocket:', e);
                    return res.status(500).json({ error: 'internal_error', message: e.message });
                }
            });

            // API: resetar sessão (apagar tokens e reiniciar bot para gerar novo QR)
            app.post('/api/session/reset', async (req, res) => {
                try {
                    // Tenta deslogar da sessão atual para invalidar pareamento
                    try { if (self.bot?.client && typeof self.bot.client.logout === 'function') { await self.bot.client.logout(); } } catch (_) {}
                    // Para o bot com segurança
                    try { await self.bot.stop(); } catch (_) {}
                    // Apaga pasta de tokens da sessão
                    const tokensDir = path.join(__dirname, 'tokens', 'zcnet-bot');
                    try { if (fs.existsSync(tokensDir)) fs.rmSync(tokensDir, { recursive: true, force: true }); } catch (_) {}
                    // Reinicia o bot (irá gerar QR no console)
                    await self.bot.start();
                    return res.json({ ok: true });
                } catch (e) {
                    console.error('❌ Erro ao resetar sessão:', e);
                    return res.status(500).json({ error: 'internal_error' });
                }
            });

            // Middleware para capturar rotas não encontradas (404) - DEVE SER O ÚLTIMO
            app.use((req, res, next) => {
                console.log(`⚠️ Rota não encontrada: ${req.method} ${req.path}`);
                res.status(404).json({ 
                    error: 'not_found', 
                    message: `Rota ${req.method} ${req.path} não encontrada`,
                    path: req.path,
                    method: req.method
                });
            });
            
            // Middleware de tratamento de erros - DEVE SER O ÚLTIMO DEPOIS DO 404
            app.use((err, req, res, next) => {
                console.error('❌ Erro não tratado:', err);
                res.status(500).json({ 
                    error: 'internal_error', 
                    message: err.message || 'Erro interno do servidor' 
                });
            });

            console.log('✅ Todas as rotas registradas. Iniciando servidor...');
            app.listen(PORT, () => {
                console.log(`📊 Painel iniciado em http://localhost:${PORT}`);
                console.log(`🔗 QR Code disponível em: http://localhost:${PORT}/api/session/qr`);
                console.log(`🔗 Status disponível em: http://localhost:${PORT}/api/session/status`);
            });
        } catch (e) {
            console.error('❌ Falha ao iniciar painel:', e);
        }
    }
}

// Inicia a aplicação
const app = new App();
app.start().catch(error => {
    console.error('❌ Erro não capturado em start():', error);
    // Não encerrar o processo abruptamente
});

// Captura exceções globais para evitar queda silenciosa
process.on('uncaughtException', (err) => {
    console.error('⚠️ uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ unhandledRejection:', reason);
});
