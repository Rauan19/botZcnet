const WhatsAppBot = require('./whatsappBot');
const zcBillService = require('./services/zcBillService');
const zcClientService = require('./services/zcClientService');
const express = require('express');
const path = require('path');
const messageStore = require('./database'); // Carrega e inicializa o banco
const multer = require('multer');
const fs = require('fs');
const https = require('https');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

// Configuração de limpeza automática de arquivos PDF antigos
const CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutos

// Configura FFmpeg
if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
}

class App {
    constructor() {
        this.bot = new WhatsAppBot();
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
            const PORT = process.env.PORT || 3000;
            app.use(express.json());
            // Diretório de arquivos (PDFs, etc.)
            const filesDir = path.join(__dirname, 'files');
            if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
            // Endpoint para baixar/abrir arquivos por ID
            app.get('/api/files/:id', (req, res) => {
                try {
                    const id = req.params.id;
                    const filePath = path.join(filesDir, id);
                    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not_found' });
                    res.sendFile(filePath);
                } catch (e) {
                    res.status(500).json({ error: 'internal_error' });
                }
            });
            
            // Configuração do multer para upload de áudio
            const uploadDir = path.join(__dirname, 'temp_audio');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            
            const upload = multer({
                dest: uploadDir,
                limits: { fileSize: 16 * 1024 * 1024 } // 16MB
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

            // API: enviar mensagem
            app.post('/api/chats/:id/send', async (req, res) => {
                try {
                    const chatId = req.params.id;
                    const { text } = req.body;

                    if (!text || !text.trim()) {
                        return res.status(400).json({ error: 'Mensagem não pode estar vazia' });
                    }

                    // Envia mensagem pelo bot
                    const result = await this.bot.sendMessage(chatId, text.trim());
                    
                    // Registra mensagem enviada
                    messageStore.recordOutgoingMessage({
                        chatId: chatId,
                        text: text.trim(),
                        timestamp: Date.now()
                    });

                    res.json({ ok: true, messageId: result?.id || null });
                } catch (e) {
                    console.error('❌ Erro ao enviar mensagem:', e);
                    res.status(500).json({ error: e.message || 'internal_error' });
                }
            });

            // API: baixar áudio
            app.get('/api/chats/:chatId/audio/:audioId', (req, res) => {
                try {
                    const { audioId } = req.params;
                    
                    // Busca o arquivo salvo
                    const audioPath = path.join(__dirname, 'audios', `${audioId}.ogg`);
                    
                    if (!fs.existsSync(audioPath)) {
                        return res.status(404).json({ error: 'Áudio não encontrado' });
                    }
                    
                    res.setHeader('Content-Type', 'audio/ogg; codecs=opus');
                    res.sendFile(audioPath);
                } catch (e) {
                    console.error('❌ Erro ao baixar áudio:', e);
                    res.status(500).json({ error: e.message || 'Erro ao baixar áudio' });
                }
            });

            // API: enviar áudio
            app.post('/api/chats/:id/send-audio', upload.single('audio'), async (req, res) => {
                try {
                    const chatId = req.params.id;
                    const file = req.file;

                    if (!file) {
                        return res.status(400).json({ error: 'Nenhum arquivo enviado' });
                    }

                    // Converte WebM para OGG Opus (formato aceito pelo WhatsApp)
                    const outputPath = file.path + '.ogg';
                    let converted = false;
                    
                    await new Promise((resolve, reject) => {
                        ffmpeg(file.path)
                            .toFormat('ogg')
                            .audioCodec('libopus')
                            .audioBitrate(32)
                            .audioChannels(1)
                            .audioFrequency(16000)
                            .on('end', () => {
                                converted = true;
                                resolve();
                            })
                            .on('error', (err) => {
                                converted = false;
                                resolve(); // Continua mesmo se converter falhar
                            })
                            .save(outputPath);
                    });

                    // Envia áudio pelo bot
                    let finalPath = converted && fs.existsSync(outputPath) ? outputPath : file.path;
                    const result = await this.bot.sendAudio(chatId, finalPath, 'audio.ogg');
                    
                    // Salva o áudio para playback futuro
                    const audioId = result?.id || `audio_${Date.now()}`;
                    const audioData = fs.readFileSync(finalPath);
                    const audioDir = path.join(__dirname, 'audios');
                    if (!fs.existsSync(audioDir)) {
                        fs.mkdirSync(audioDir, { recursive: true });
                    }
                    const audioPath = path.join(audioDir, `${audioId}.ogg`);
                    fs.writeFileSync(audioPath, audioData);
                    
                    // Registra mensagem enviada com o ID do áudio
                    messageStore.recordOutgoingMessage({
                        chatId: chatId,
                        text: '[áudio]',
                        timestamp: Date.now(),
                        audioId: audioId
                    });
                    
                    // Remove arquivo temporário
                    try {
                        // Remove arquivo convertido se existir
                        if (converted && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                        // Remove arquivo original
                        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
                    } catch (e) {}

                    res.json({ ok: true, messageId: result?.id || null });
                } catch (e) {
                    console.error('❌ Erro ao enviar áudio:', e);
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

            // QR Code atual (se disponível)
            app.get('/api/session/qr', (req, res) => {
                try {
                    if (!this.bot || typeof this.bot.getLastQr !== 'function') {
                        return res.status(503).json({ error: 'unavailable' });
                    }
                    const qr = this.bot.getLastQr();
                    if (!qr) return res.status(404).json({ error: 'no_qr' });
                    res.setHeader('Content-Type', qr.contentType || 'image/png');
                    return res.send(qr.buffer);
                } catch (e) {
                    return res.status(500).json({ error: 'internal_error' });
                }
            });

            app.listen(PORT, () => {
                console.log(`📊 Painel iniciado em http://localhost:${PORT}`);
            });
            
            // API: resetar sessão (apagar tokens e reiniciar bot para gerar novo QR)
            app.post('/api/session/reset', async (req, res) => {
                try {
                    // Tenta deslogar da sessão atual para invalidar pareamento
                    try { if (this.bot?.client && typeof this.bot.client.logout === 'function') { await this.bot.client.logout(); } } catch (_) {}
                    // Para o bot com segurança
                    try { await this.bot.stop(); } catch (_) {}
                    // Apaga pasta de tokens da sessão
                    const tokensDir = path.join(__dirname, 'tokens', 'zcnet-bot');
                    try { if (fs.existsSync(tokensDir)) fs.rmSync(tokensDir, { recursive: true, force: true }); } catch (_) {}
                    // Reinicia o bot (irá gerar QR no console)
                    await this.bot.start();
                    return res.json({ ok: true });
                } catch (e) {
                    console.error('❌ Erro ao resetar sessão:', e);
                    return res.status(500).json({ error: 'internal_error' });
                }
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
