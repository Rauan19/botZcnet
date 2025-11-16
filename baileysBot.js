const fs = require('fs');
const path = require('path');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const mime = require('mime-types');
const qrcode = require('qrcode');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    Browsers
} = require('@whiskeysockets/baileys');

const messageStore = require('./database');
const zcBillService = require('./services/zcBillService');
const zcClientService = require('./services/zcClientService');

class BaileysBot {
    constructor() {
        this.sock = null;
        this.client = null;
        this.started = false;
        this.qrString = null;
        this.logger = P({
            level: process.env.BAILEYS_LOG_LEVEL || 'fatal',
            timestamp: () => `,"time":"${new Date().toISOString()}"`
        });
        this.authDir = path.join(__dirname, 'tokens-baileys');
        this.reconnectRequested = false;
        this.conversationContext = new Map();
        this.userStates = new Map(); // guarda último contexto por usuário (clientId, serviceId, billId)
        this.lastResponseTime = new Map(); // rate limiting por chat
        this.processedMessages = new Map(); // evita processar mensagens duplicadas
        
        // Limpeza automática de contexto a cada 30 minutos (não muito agressiva)
        setInterval(() => this.cleanupOldContexts(), 30 * 60 * 1000);
        // Limpeza automática de userStates a cada 1 hora
        setInterval(() => this.cleanupOldUserStates(), 60 * 60 * 1000);
        // Limpeza automática de rate limiting a cada 10 minutos
        setInterval(() => this.cleanupRateLimiting(), 10 * 60 * 1000);
    }

    async start() {
        if (this.started) {
            console.log('⚠️ Baileys já iniciado.');
            return;
        }

        if (!fs.existsSync(this.authDir)) {
            fs.mkdirSync(this.authDir, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
        this.saveCreds = saveCreds;
        const { version } = await fetchLatestBaileysVersion();

        this.sock = makeWASocket({
            version,
            auth: state,
            logger: this.logger,
            browser: Browsers.macOS('Chrome'),
            markOnlineOnConnect: false,
            syncFullHistory: false,
            emitOwnEvents: false,
            generateHighQualityLinkPreview: false,
            printQRInTerminal: false
        });

        this.client = this.sock;

        this.sock.ev.on('connection.update', (update) => {
            this.handleConnectionUpdate(update).catch(err => console.error('❌ ERRO conexão Baileys:', err));
        });

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('messages.upsert', (payload) => {
            this.handleMessagesUpsert(payload).catch(err => console.error('❌ ERRO mensagens Baileys:', err));
        });

        this.started = true;
        console.log('✅ Bot Baileys inicializado.');
    }

    async handleConnectionUpdate(update) {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            this.qrString = qr;
            console.log('📱 QR code Baileys atualizado. Acesse /api/session/qr para visualizar.');
        }

        if (connection === 'open') {
            console.log('🤝 Baileys conectado.');
            this.qrString = null;
        } else if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log('⚠️ Baileys desconectado:', statusCode);
            this.started = false;

            if (statusCode === DisconnectReason.loggedOut) {
                console.log('🧹 Sessão Baileys inválida. Limpando tokens para gerar novo QR.');
                this.cleanupAuthDir();
            }

            if (!this.pauseRequested) {
                console.log('🔄 Tentando reconectar Baileys em 5s...');
                setTimeout(() => {
                    if (!this.started) {
                        this.start().catch(err => console.error('❌ Falha ao reconectar Baileys:', err));
                    }
                }, 5000);
            }
        }
    }

    cleanupAuthDir() {
        try {
            if (fs.existsSync(this.authDir)) {
                fs.rmSync(this.authDir, { recursive: true, force: true });
            }
        } catch (e) {
            console.error('⚠️ Erro ao limpar tokens Baileys:', e);
        }
    }

    async handleMessagesUpsert({ messages, type }) {
        if (type !== 'notify') return;
        for (const msg of messages) {
            try {
                if (!msg.message) continue;

                const jid = msg.key.remoteJid;
                
                // Ignora se não tem JID válido
                if (!jid || typeof jid !== 'string') {
                    continue;
                }
                
                // Ignora grupos (@g.us)
                if (jid.endsWith('@g.us')) {
                    continue;
                }
                
                // Ignora status/stories (broadcast)
                if (jid.includes('status@broadcast') || jid.includes('broadcast') || jid.includes('@broadcast')) {
                    continue;
                }
                
                // Ignora mensagens de sistema/protocolo
                if (msg.message.protocolMessage || msg.message.senderKeyDistributionMessage) {
                    continue;
                }
                
                // Ignora mensagens de revogação (apagadas)
                if (msg.message.protocolMessage?.type === 2) {
                    continue;
                }

                const fromMe = msg.key.fromMe === true;
                const chatId = this.toPanelChatId(jid);
                const body = this.extractMessageText(msg);

                console.log(`📩 [Baileys] ${chatId}: ${body}`);

                if (!fromMe) {
                    try {
                        messageStore.recordIncomingMessage({
                            chatId,
                            sender: chatId,
                            text: body,
                            timestamp: Date.now(),
                            name: msg.pushName || ''
                        });
                    } catch (_) {}
                }

                if (fromMe) {
                    continue;
                }

                // Rate limiting removido daqui - agora é verificado depois, permitindo seleções de menu rápidas

                // Ignora mensagens muito antigas (> 5 minutos)
                let messageTimestamp = Date.now();
                if (msg.messageTimestamp) {
                    if (typeof msg.messageTimestamp === 'object' && msg.messageTimestamp.low) {
                        messageTimestamp = msg.messageTimestamp.low * 1000;
                    } else if (typeof msg.messageTimestamp === 'number') {
                        messageTimestamp = msg.messageTimestamp * 1000;
                    }
                }
                const messageAge = Date.now() - messageTimestamp;
                if (messageAge > 5 * 60 * 1000) {
                    console.log(`⏰ [${chatId}] Mensagem muito antiga (${Math.floor(messageAge / 60000)} min), ignorando`);
                    continue;
                }

                // Ignora mensagens duplicadas (mesmo texto em < 5 segundos)
                if (this.isDuplicateMessage(chatId, body)) {
                    console.log(`🔄 [${chatId}] Mensagem duplicada, ignorando`);
                    continue;
                }

                const normalized = this.normalizeText(body);
                const context = this.getConversationContext(chatId);

                // Log detalhado para debug
                console.log(`📩 [${chatId}] Mensagem: "${body.substring(0, 50)}" | Normalizada: "${normalized}" | Contexto: ${context.currentMenu}/${context.currentStep || 'null'}`);

                // Verifica se é seleção de menu válida (1-9) - permite passar rate limiting
                const isMenuSelection = /^[1-9]$/.test(normalized);
                
                // Rate limiting: NÃO aplica para seleções de menu válidas (resposta rápida)
                // Aplica apenas para outras mensagens para evitar spam
                if (!isMenuSelection && !this.canRespond(chatId)) {
                    console.log(`⏱️ [${chatId}] Rate limit atingido, ignorando mensagem`);
                    continue;
                }

                // Trata comando de menu (8) em qualquer contexto (ANTES de shouldIgnoreMessage)
                if (this.isMenuCommand(normalized)) {
                    await this.sendMenu(chatId);
                    continue;
                }

                // Verifica saudações ANTES de shouldIgnoreMessage (para não ignorar "oi", "oii", etc)
                if (!normalized || this.isGreeting(normalized)) {
                    await this.sendMenu(chatId);
                    continue;
                }

                // Ignora palavras de despedida/confirmação fora de contexto (DEPOIS de verificar saudações)
                if (this.shouldIgnoreMessage(normalized, context)) {
                    console.log(`🔇 [${chatId}] Mensagem ignorada (shouldIgnoreMessage)`);
                    continue;
                }

                if (await this.handleSupportSubmenu(chatId, normalized, context)) {
                    continue;
                }

                const handled = await this.handleMenuSelection(chatId, normalized, context);
                if (handled) continue;

                // Verifica se está aguardando escolha entre PIX e boleto
                if (context.currentMenu === 'payment' && context.currentStep === 'waiting_payment_option') {
                    const ctx = this.userStates.get(chatId);

                    // Cliente escolheu PIX (opção 1 ou palavra "pix")
                    if (normalized === '1' || normalized === 'pix' || normalized.trim() === 'pix') {
                        if (!ctx) {
                            await this.sendText(chatId, '*❌ ERRO*\n\nDados não encontrados. Por favor, envie seu CPF novamente.\n———\nDigite *8* para voltar ao menu.');
                            this.setConversationContext(chatId, {
                                currentMenu: 'payment',
                                currentStep: 'waiting_cpf'
                            });
                            continue;
                        }

                        // Gera e envia PIX diretamente
                        try {
                            const pix = await this.retryApiCall(async () => {
                                return await zcBillService.generatePixQRCode(ctx.clientId, ctx.serviceId, ctx.billId);
                            }, 2);
                            const parsed = this.parsePixPayload(pix);

                            if (parsed.imageBase64) {
                                await this.sendText(chatId, 'QR code PIX. Escaneie para pagar via PIX.');
                                await this.sendImageFromBase64(chatId, parsed.imageBase64, 'pix.png', '*🔵 QRCODE PIX*\n\n*ESCANEIE PARA PAGAR VIA PIX*');

                                try {
                                    const filesDir = path.join(__dirname, 'files');
                                    if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });

                                    let base64Data = parsed.imageBase64;
                                    if (typeof base64Data === 'string' && base64Data.includes(',')) {
                                        base64Data = base64Data.split(',')[1];
                                    }

                                    const imageBuffer = Buffer.from(base64Data, 'base64');
                                    const fileId = `qrcode_${Date.now()}_${Math.random().toString(36).slice(2)}.png`;
                                    const destPath = path.join(filesDir, fileId);
                                    fs.writeFileSync(destPath, imageBuffer);

                                    messageStore.recordOutgoingMessage({
                                        chatId: chatId,
                                        text: '🔵 QRCode PIX',
                                        timestamp: Date.now(),
                                        fileId,
                                        fileName: 'qrcode-pix.png',
                                        fileType: 'image/png'
                                    });
                                } catch (_) {
                                    try { messageStore.recordOutgoingMessage({ chatId: chatId, text: '[imagem] QRCode PIX', timestamp: Date.now() }); } catch (_) {}
                                }
                            }

                            if (parsed.payload) {
                                await this.sendText(chatId, 'Copia o código abaixo e cole no seu banco para efetuar o pagamento');
                                await new Promise(resolve => setTimeout(resolve, 500));
                                await this.sendText(chatId, parsed.payload);
                                try { messageStore.recordOutgoingMessage({ chatId: chatId, text: parsed.payload, timestamp: Date.now() }); } catch (_) {}
                            }

                            if (!parsed.imageBase64 && !parsed.payload) {
                                await this.sendText(chatId, 'Erro! PIX gerado, mas não recebi imagem nem código utilizável da API.\n———\nDigite *8* para voltar ao menu.');
                                continue;
                            }

                            // Envia mensagem pós-PIX
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            const postPixMsg = `*PIX ENVIADO!*

⏱️ *Liberação em até 5 minutos*

*Se após 5 minutos não houve liberação automática:*

*• Desligue e ligue o roteador*
*• Aguarde a reconexão*

📞 *Não voltou?* Digite *"3"*

———
📱 *Digite 8 para voltar ao menu*`;

                            this.setConversationContext(chatId, {
                                currentMenu: 'payment',
                                currentStep: 'waiting_payment_confirmation'
                            });

                            await this.sendText(chatId, postPixMsg);
                            // Após enviar PIX, ignora mensagens até receber comando de menu
                            this.setConversationContext(chatId, {
                                currentMenu: 'payment',
                                currentStep: 'payment_sent',
                                ignoreUntilMenu: true
                            });
                            continue;

                        } catch (e) {
                            const errorInfo = this.getApiErrorMessage(e);
                            console.error(`❌ [${chatId}] Erro ao gerar PIX:`, errorInfo.logMessage);
                            console.error(`❌ [${chatId}] Detalhes:`, e?.message || e);
                            if (e?.stack) console.error(`❌ [${chatId}] Stack trace:`, e.stack);
                            await this.sendText(chatId, errorInfo.userMessage);
                            continue;
                        }
                    }

                    // Cliente escolheu BOLETO (opção 2)
                    if (normalized === '2' || normalized.includes('boleto')) {
                        if (!ctx) {
                            await this.sendText(chatId, '*❌ ERRO*\n\nDados não encontrados. Por favor, envie seu CPF novamente.\n———\nDigite *8* para voltar ao menu.');
                            this.setConversationContext(chatId, {
                                currentMenu: 'payment',
                                currentStep: 'waiting_cpf'
                            });
                            continue;
                        }

                        // Gera e envia boleto
                        try {
                            const pdfPath = await this.retryApiCall(async () => {
                                return await zcBillService.generateBillPDF(ctx.clientId, ctx.serviceId, ctx.billId);
                            }, 2);
                            const caption = `*📄 BOLETO DE ${ctx.clientName || 'cliente'}*\n\n⏱️ *Liberação em até 5 minutos após o pagamento*\n\n———\n📱 *Digite 8 para voltar ao menu*`;

                            this.setConversationContext(chatId, {
                                currentMenu: 'payment',
                                currentStep: 'waiting_payment_confirmation'
                            });

                            await this.sendText(chatId, `Boleto de ${ctx.clientName || 'cliente'}. Liberação em até 5 minutos após o pagamento.`);
                            await this.sendFile(chatId, pdfPath, 'boleto.pdf', caption);

                            try {
                                const filesDir = path.join(__dirname, 'files');
                                if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
                                const fileId = `boleto_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`;
                                const destPath = path.join(filesDir, fileId);
                                fs.copyFileSync(pdfPath, destPath);
                                messageStore.recordOutgoingMessage({
                                    chatId: chatId,
                                    text: caption,
                                    timestamp: Date.now(),
                                    fileId,
                                    fileName: 'boleto.pdf',
                                    fileType: 'application/pdf'
                                });
                            } catch (_) {
                                try { messageStore.recordOutgoingMessage({ chatId: chatId, text: '[arquivo] boleto.pdf - ' + caption, timestamp: Date.now() }); } catch (_) {}
                            }

                            // Após enviar boleto, ignora mensagens até receber comando de menu
                            this.setConversationContext(chatId, {
                                currentMenu: 'payment',
                                currentStep: 'payment_sent',
                                ignoreUntilMenu: true
                            });
                            continue;

                        } catch (e) {
                            const errorInfo = this.getApiErrorMessage(e);
                            console.error(`❌ [${chatId}] Erro ao gerar boleto:`, errorInfo.logMessage);
                            console.error(`❌ [${chatId}] Detalhes:`, e?.message || e);
                            if (e?.stack) console.error(`❌ [${chatId}] Stack trace:`, e.stack);
                            await this.sendText(chatId, errorInfo.userMessage);
                            continue;
                        }
                    }

                    // Se não é nem PIX nem boleto, pede escolha novamente
                    const response = `*Por favor, escolha uma opção:*

*1️⃣ PIX* (ou digite *pix*)

*2️⃣ BOLETO*

———
Digite o *número* da opção ou *8* para voltar ao menu.`;
                    await this.sendText(chatId, response);
                    continue;
                }

                // Se está em payment_sent, ignora tudo exceto comando de menu
                if (context.currentMenu === 'payment' && context.currentStep === 'payment_sent' && context.ignoreUntilMenu) {
                    // Apenas comandos de menu podem sair desse estado
                    if (!this.isMenuCommand(normalized)) {
                        continue; // Ignora mensagem
                    }
                    // Se é comando de menu, reseta contexto e continua
                    this.setConversationContext(chatId, {
                        currentMenu: 'main',
                        currentStep: null
                    });
                }

                if (context.currentMenu === 'payment' && context.currentStep === 'waiting_cpf') {
                    // Extrai apenas os dígitos (aceita com ou sem pontuação)
                    const digits = (body.match(/\d/g) || []).join('');
                    
                    if (digits.length === 11) {
                        // Valida CPF antes de processar
                        if (!this.validateCPF(digits)) {
                            console.log(`⚠️ CPF inválido recebido de ${chatId}: ${digits.substring(0, 3)}.***.***-**`);
                            await this.sendText(
                                chatId,
                                'CPF inválido. Verifique os números e envie novamente.\n———\nDigite *8* para voltar ao menu.'
                            );
                            continue;
                        }
                        console.log(`✅ CPF válido recebido de ${chatId} (${digits.substring(0, 3)}.***.***-**), processando...`);
                        await this.handlePaymentCpf(chatId, digits);
                    } else if (digits.length > 0 && digits.length < 11) {
                        await this.sendText(
                            chatId,
                            `CPF incompleto. Encontrei apenas ${digits.length} dígitos. Preciso de 11 números.\n———\nDigite *8* para voltar ao menu.`
                        );
                    } else if (digits.length > 11) {
                        await this.sendText(
                            chatId,
                            `CPF com muitos dígitos. Encontrei ${digits.length} dígitos. Preciso de exatamente 11 números.\n———\nDigite *8* para voltar ao menu.`
                        );
                    } else {
                        await this.sendText(
                            chatId,
                            'Preciso do CPF com 11 números para localizar seu cadastro.\n———\nDigite *8* para voltar ao menu.'
                        );
                    }
                    continue;
                }

                // PROTEÇÃO CRÍTICA: Se CPF vem fora de contexto, IGNORA completamente
                const digits = (body.match(/\d/g) || []).join('');
                if (digits.length === 11 && context.currentMenu !== 'payment') {
                    // CPF fora de contexto - pode ser conversa com atendente
                    // Bot não deve processar
                    console.log(`🚫 [${chatId}] CPF fora de contexto ignorado: ${digits.substring(0, 3)}.***.***-**`);
                    continue;
                }

                // Fora dos fluxos conhecid
            } catch (err) {
                console.error('❌ Erro ao processar mensagem Baileys:', err);
            }
        }
    }

    isGroupJid(jid) {
        if (!jid || typeof jid !== 'string') return false;
        // Grupos terminam com @g.us
        if (jid.endsWith('@g.us')) return true;
        // Status/stories são broadcasts
        if (jid.includes('status@broadcast') || jid.includes('broadcast')) return true;
        return false;
    }

    extractMessageText(message) {
        if (!message || !message.message) return '';
        const msg = message.message;
        if (msg.conversation) return msg.conversation;
        if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
        if (msg.documentMessage?.caption) return msg.documentMessage.caption;
        if (msg.imageMessage?.caption) return msg.imageMessage.caption;
        if (msg.audioMessage) return '[áudio]';
        if (msg.videoMessage) return '[vídeo]';
        return '[mensagem]';
    }

    normalizeChatId(chatId) {
        if (!chatId) throw new Error('chatId inválido');
        let id = String(chatId).trim();
        if (id.includes('@g.us')) return id;
        if (id.includes('@s.whatsapp.net')) return id;
        if (id.includes('@c.us')) return id.replace('@c.us', '@s.whatsapp.net');
        if (id.includes('-')) {
            return id.endsWith('@g.us') ? id : `${id}@g.us`;
        }
        id = id.replace(/\D/g, '');
        return `${id}@s.whatsapp.net`;
    }

    toPanelChatId(jid) {
        if (!jid) return '';
        if (jid.endsWith('@s.whatsapp.net')) return jid.replace('@s.whatsapp.net', '@c.us');
        return jid;
    }

    // Funções de proteção contra spam e mensagens fora de contexto
    
    canRespond(chatId) {
        const lastResponse = this.lastResponseTime.get(chatId);
        if (!lastResponse) {
            return true;
        }
        const timeSinceLastResponse = Date.now() - lastResponse;
        return timeSinceLastResponse >= 1000; // Mínimo 1 segundo entre respostas (reduzido de 3s para ser mais rápido)
    }

    recordResponse(chatId) {
        this.lastResponseTime.set(chatId, Date.now());
    }

    isDuplicateMessage(chatId, text) {
        const key = `${chatId}:${text}`;
        const lastTime = this.processedMessages.get(key);
        if (!lastTime) {
            this.processedMessages.set(key, Date.now());
            // Limpa mensagens antigas (> 10 segundos)
            setTimeout(() => {
                this.processedMessages.delete(key);
            }, 10000);
            return false;
        }
        const timeSinceLastMessage = Date.now() - lastTime;
        return timeSinceLastMessage < 5000; // Mensagem duplicada se < 5 segundos
    }

    shouldIgnoreMessage(normalized, context) {
        if (!normalized) return true;

        // Se está aguardando pagamento ser enviado, ignora tudo exceto menu
        if (context.currentStep === 'payment_sent' && context.ignoreUntilMenu) {
            return true;
        }

        // NÃO ignora saudações (já foram tratadas antes desta função)
        if (this.isGreeting(normalized)) {
            return false;
        }

        // Lista de palavras que bot deve ignorar completamente
        const ignoreWords = [
            'tchau', 'obrigado', 'obrigada', 'valeu', 'ok', 'okay', 'entendi', 
            'beleza', 'sim', 'nao', 'não', 'claro', 'perfeito', 'otimo', 'ótimo',
            'haha', 'kkk', 'rs', '👍', '😊', '👍🏻', 'ok obrigado', 'ok obrigada',
            'tudo bem', 'tudo certo', 'de nada', 'disponha', 'por nada'
        ];

        if (ignoreWords.includes(normalized)) {
            return true;
        }

        // Palavras que indicam necessidade de atendente humano (fora de contexto)
        const humanNeeded = [
            'preciso falar', 'quero conversar', 'tenho duvida', 'tenho dúvida',
            'nao entendi', 'não entendi', 'preciso ajuda', 'preciso de ajuda',
            'atendente', 'falar com alguem', 'falar com alguém'
        ];

        if (humanNeeded.some(phrase => normalized.includes(phrase)) && context.currentMenu === 'main') {
            return true; // Cliente precisa de atendente, bot não deve responder
        }

        return false;
    }


    async sendMessage(chatId, text) {
        const jid = this.normalizeChatId(chatId);
        await this.ensureSocket();
        const result = await this.sock.sendMessage(jid, { text });
        this.recordOutgoingMessage(jid, text);
        this.recordResponse(chatId); // Registra tempo de resposta para rate limiting
        return result;
    }

    async sendText(chatId, text) {
        return this.sendMessage(chatId, text);
    }

    async sendFile(chatId, filePath, fileName, caption = '') {
        const jid = this.normalizeChatId(chatId);
        await this.ensureSocket();
        const buffer = fs.readFileSync(filePath);
        const mimetype = mime.lookup(filePath) || 'application/octet-stream';
        const finalName = fileName || path.basename(filePath);
        const result = await this.sock.sendMessage(jid, {
            document: buffer,
            mimetype,
            fileName: finalName,
            caption
        });
        this.recordOutgoingMessage(jid, caption || `[arquivo: ${finalName}]`);
        return result;
    }

    async sendImageFromBase64(chatId, base64Image, filename, caption = '') {
        const jid = this.normalizeChatId(chatId);
        await this.ensureSocket();
        let data = base64Image;
        if (base64Image.includes(',')) {
            data = base64Image.split(',')[1];
        }
        const buffer = Buffer.from(data, 'base64');
        const mimetype = 'image/png';
        const finalName = filename || `image_${Date.now()}.png`;
        const result = await this.sock.sendMessage(jid, {
            image: buffer,
            mimetype,
            caption,
            fileName: finalName
        });
        this.recordOutgoingMessage(jid, caption || '[imagem]');
        return result;
    }

    async sendPtt(chatId, audioPath) {
        const jid = this.normalizeChatId(chatId);
        await this.ensureSocket();
        const result = await this.sock.sendMessage(jid, {
            audio: { url: audioPath },
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true
        });
        this.recordOutgoingMessage(jid, '[áudio]');
        return result;
    }

    async sendAudio(chatId, audioPath, fileName = 'audio.ogg') {
        return this.sendPtt(chatId, audioPath, fileName);
    }

    async sendKeepingUnread(sendFn) {
        if (typeof sendFn !== 'function') throw new Error('sendFn inválido');
        return await sendFn();
    }

    recordOutgoingMessage(jid, text) {
        const chatId = this.toPanelChatId(jid);
        try {
            messageStore.recordOutgoingMessage({
                chatId: chatId,
                text,
                timestamp: Date.now()
            });
        } catch (_) {}
    }

    async sendMenu(chatId) {
        const menuMsg = `*COMO POSSO AJUDAR?*

*1️⃣ PAGAMENTO / SEGUNDA VIA*

*2️⃣ SUPORTE TÉCNICO*

*3️⃣ FALAR COM ATENDENTE*

*4️⃣ OUTRAS DÚVIDAS*

———
Digite o *número* da opção ou envie *8* para voltar ao menu.`;

        this.setConversationContext(chatId, {
            currentMenu: 'main',
            currentStep: null
        });

        await this.sendText(chatId, menuMsg);
    }

    isMenuCommand(normalizedText) {
        if (!normalizedText) return true;
        if (normalizedText === '8') return true;
        return normalizedText.includes('menu');
    }

    normalizeText(text) {
        if (!text) return '';
        return text
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .trim();
    }

    isGreeting(normalizedText) {
        if (!normalizedText) return false;
        const greetings = [
            'oi', 'oie', 'oii', 'ola', 'ola!', 'olaa',
            'bom dia', 'bomdia', 'boa tarde', 'boatarde',
            'boa noite', 'boanoite', 'bomdia!', 'boatarde!', 'boanoite!'
        ];
        return greetings.includes(normalizedText);
    }

    async handleMenuSelection(chatId, normalizedText, context = null) {
        const isMainMenu = !context || context.currentMenu === 'main' || !context.currentMenu;

        if (!isMainMenu) {
            return false;
        }

        if (normalizedText === '1') {
            const response = `*PAGAMENTO / SEGUNDA VIA*

Para gerar seu boleto ou PIX, envie seu *CPF*.

———
Digite *8* para voltar ao menu.`;
            this.setConversationContext(chatId, {
                currentMenu: 'payment',
                currentStep: 'waiting_cpf'
            });
            await this.sendText(chatId, response);
            return true;
        }

        if (normalizedText === '2') {
            const response = `*SUPORTE TÉCNICO*

1️⃣ Internet lenta
2️⃣ Sem conexão
3️⃣ Já paguei

———
Digite o número da opção ou *8* para voltar ao menu.`;
            this.setConversationContext(chatId, {
                currentMenu: 'support_sub',
                currentStep: 'waiting_option'
            });
            await this.sendText(chatId, response);
            return true;
        }

        if (normalizedText === '3') {
            const response = 'Um atendente humano vai assumir. Aguarde alguns instantes.';
            // Bot não pausa mais - funcionalidade removida
            await this.sendText(chatId, response);
            return true;
        }

        if (normalizedText === '4') {
            const response = 'Envie sua dúvida e nossa equipe irá analisar.\n———\nDigite *8* para voltar ao menu.';
            this.setConversationContext(chatId, {
                currentMenu: 'other',
                currentStep: null
            });
            await this.sendText(chatId, response);
            return true;
        }

        return false;
    }

    async handleSupportSubmenu(chatId, normalizedText, context) {
        if (!context || context.currentMenu !== 'support_sub') {
            return false;
        }

        // Se está aguardando escolha inicial do submenu
        if (context.currentStep === 'waiting_option') {
            if (normalizedText === '1') {
                await this.sendText(chatId, '🔧 *INTERNET LENTA*\n\nDesligue e ligue os equipamentos, aguarde alguns minutos e teste a conexão.\n\nSe o problema persistir, digite *3*.\n\n———\nDigite *8* para voltar ao menu.');
                // Atualiza contexto para indicar que está dentro do submenu "INTERNET LENTA"
                this.setConversationContext(chatId, {
                    currentMenu: 'support_sub',
                    currentStep: 'internet_lenta'
                });
                return true;
            }

            if (normalizedText === '2') {
                await this.sendText(chatId, '🚫 *SEM CONEXÃO*\n\nVerifique cabos e energia do roteador. Caso persista, aguarde alguns minutos.\n\nPrecisa falar com suporte? Responda *3*.\n———\nDigite *8* para voltar ao menu.');
                // Atualiza contexto para indicar que está dentro do submenu "SEM CONEXÃO"
                this.setConversationContext(chatId, {
                    currentMenu: 'support_sub',
                    currentStep: 'sem_conexao'
                });
                return true;
            }

            if (normalizedText === '3') {
                await this.sendText(
                    chatId,
                    '🧾 *JÁ PAGUEI*\n\nSe você já quitou o boleto/PIX, aguarde até 5 minutos para que o sistema atualize.\nCaso não volte em breve, nosso time entrará em contato para finalizar a liberação.\n———\nDigite *8* para voltar ao menu.'
                );
                // Reseta contexto após mostrar resposta
                this.setConversationContext(chatId, {
                    currentMenu: 'main',
                    currentStep: null
                });
                return true;
            }
        }

        // Se está dentro do submenu "SEM CONEXÃO" e cliente digita "3"
        if (context.currentStep === 'sem_conexao' && normalizedText === '3') {
            await this.sendText(chatId, 'Em breve um dos nossos atendentes irá continuar nosso atendimento.');
            // Reseta contexto após mostrar resposta
            this.setConversationContext(chatId, {
                currentMenu: 'main',
                currentStep: null
            });
            return true;
        }

        // Se está dentro do submenu "INTERNET LENTA" e cliente digita "3"
        if (context.currentStep === 'internet_lenta' && normalizedText === '3') {
            await this.sendText(chatId, 'Em breve um dos nossos atendentes irá continuar nosso atendimento.');
            // Reseta contexto após mostrar resposta
            this.setConversationContext(chatId, {
                currentMenu: 'main',
                currentStep: null
            });
            return true;
        }

        return false;
    }

    parsePixPayload(apiResponse) {
        // Tenta encontrar campos comuns
        const obj = apiResponse && apiResponse.data ? apiResponse.data : apiResponse;
        let payload = null;
        let imageBase64 = null;

        if (!obj) return { payload, imageBase64 };

        // Possíveis nomes de campos
        const payloadCandidates = [
            'payload', 'emv', 'qrcode', 'qrCode', 'qr_code', 'codigo', 'chave', 'copyPaste', 'copiaecola', 'copiaECola'
        ];
        for (const k of payloadCandidates) {
            if (typeof obj[k] === 'string' && obj[k].length > 10) { payload = obj[k]; break; }
        }

        // Imagem base64
        const imageCandidates = ['base64', 'imagem', 'imagemQrcode', 'image', 'imageBase64'];
        for (const k of imageCandidates) {
            if (typeof obj[k] === 'string' && obj[k].length > 100) {
                const hasHeader = obj[k].startsWith('data:image');
                imageBase64 = hasHeader ? obj[k] : `data:image/png;base64,${obj[k]}`;
                break;
            }
        }

        return { payload, imageBase64 };
    }

    // Função auxiliar para retry de chamadas de API
    async retryApiCall(apiCall, maxRetries = 2, delayMs = 1000) {
        let lastError;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await apiCall();
            } catch (error) {
                lastError = error;
                // Se não é o último attempt, espera antes de tentar novamente
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, delayMs * (attempt + 1)));
                    console.log(`🔄 Tentativa ${attempt + 2}/${maxRetries + 1} da chamada de API...`);
                }
            }
        }
        throw lastError;
    }

    // Função auxiliar para detectar tipo de erro da API
    getApiErrorMessage(error) {
        const errorMsg = error?.message || String(error || '').toLowerCase();
        const errorCode = error?.code || '';
        
        // Erro de conexão/rede
        if (errorCode === 'ECONNREFUSED' || errorCode === 'ENOTFOUND' || 
            errorMsg.includes('econnrefused') || errorMsg.includes('enotfound') ||
            errorMsg.includes('network') || errorMsg.includes('conexão')) {
            return {
                userMessage: '⚠️ *Serviço temporariamente indisponível*\n\nNossa API está fora do ar no momento. Por favor, tente novamente em alguns minutos.\n\n———\nDigite *8* para voltar ao menu.',
                logMessage: 'API offline ou inacessível'
            };
        }
        
        // Timeout
        if (errorCode === 'ECONNABORTED' || errorMsg.includes('timeout') || 
            errorMsg.includes('demorou') || errorMsg.includes('tempo')) {
            return {
                userMessage: '⏱️ *Consulta demorou muito*\n\nO servidor demorou para responder. Isso pode ser temporário.\n\nTente novamente em instantes ou envie *8* para voltar ao menu.',
                logMessage: 'Timeout na chamada de API'
            };
        }
        
        // Erro genérico da API
        if (error?.response?.status) {
            const status = error.response.status;
            if (status >= 500) {
                return {
                    userMessage: '⚠️ *Erro no servidor*\n\nNossa API está com problemas. Tente novamente em alguns minutos.\n\n———\nDigite *8* para voltar ao menu.',
                    logMessage: `Erro HTTP ${status} da API`
                };
            }
        }
        
        // Erro padrão
        return {
            userMessage: '❌ *Erro ao processar solicitação*\n\nOcorreu um erro inesperado. Tente novamente ou envie *8* para voltar ao menu.',
            logMessage: `Erro desconhecido: ${errorMsg}`
        };
    }

    async handlePaymentCpf(chatId, digits) {
        // Atualiza contexto: CPF recebido, processando
        this.setConversationContext(chatId, {
            currentMenu: 'payment',
            currentStep: 'processing_cpf'
        });

        // Responde imediatamente que está processando
        await this.sendText(chatId, 'Processando CPF, aguarde...');

        try {
            // Busca cliente com retry (tenta até 3 vezes)
            const cli = await this.retryApiCall(async () => {
                return await Promise.race([
                    zcClientService.getClientByDocument(digits),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
                ]);
            }, 2); // 2 retries = 3 tentativas no total

            if (!cli || !cli.id) {
                throw new Error('Nenhum cliente encontrado');
            }

            // Busca serviços com retry
            const services = await this.retryApiCall(async () => {
                return await Promise.race([
                    zcClientService.getClientServices(cli.id),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
                ]);
            }, 2);

            if (!services || services.length === 0) {
                await this.sendText(chatId, 'Cliente encontrado mas sem serviços ativos.\n———\nDigite *8* para voltar ao menu.');
                return;
            }
            const activeService = services.find(s => s.status === 'ativo') || services[0];

            // Busca contas com retry
            const bills = await this.retryApiCall(async () => {
                return await Promise.race([
                    zcBillService.getBills(cli.id, activeService.id, 'INTERNET'),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
                ]);
            }, 2);

            if (!bills || bills.length === 0) {
                await this.sendText(chatId, 'Nenhuma cobrança encontrada para este cliente.\n———\nDigite *8* para voltar ao menu.');
                return;
            }

            // Filtra boletos: aceita apenas não pagos (dataPagamento null e status indica em aberto)
            const filteredBills = bills.filter(bill => {
                // Aceita boleto que tenha ID válido
                if (!bill || !bill.id) {
                    return false;
                }

                // Verifica se está pago pelo campo dataPagamento
                const dataPagamento = bill.dataPagamento || bill.data_pagamento;
                if (dataPagamento !== null && dataPagamento !== undefined && dataPagamento !== '') {
                    return false;
                }

                // Verifica se está pago pelo campo status
                const statusDescricao = (bill.statusDescricao || bill.status_descricao || '').toLowerCase();

                // Status 0 geralmente significa "Em Aberto", outros valores podem indicar pago
                // Mas vamos ser conservadores: se statusDescricao indica pago, exclui
                if (statusDescricao.includes('pago') || statusDescricao.includes('quitado') ||
                    statusDescricao.includes('liquidado') || statusDescricao.includes('cancelado')) {
                    return false;
                }

                return true;
            });

            // Se não encontrou boletos válidos, retorna erro
            if (filteredBills.length === 0) {
                await this.sendText(chatId, 'Não há nenhuma cobrança em atraso. Entre em contato conosco caso tenha dúvidas.\n———\nDigite *8* para voltar ao menu.');
                return;
            }

            // Ordena priorizando boletos vencidos ou do mês atual, depois futuros
            const now = new Date();
            now.setHours(0, 0, 0, 0);
            const currentMonth = now.getMonth();
            const currentYear = now.getFullYear();

            const latest = filteredBills.sort((a, b) => {
                const dateA = new Date(a.dataVencimento || a.data_vencimento || a.vencimento || 0);
                const dateB = new Date(b.dataVencimento || b.data_vencimento || b.vencimento || 0);

                if (isNaN(dateA.getTime()) || isNaN(dateB.getTime())) {
                    return isNaN(dateA.getTime()) ? 1 : -1;
                }

                dateA.setHours(0, 0, 0, 0);
                dateB.setHours(0, 0, 0, 0);

                const timeA = dateA.getTime();
                const timeB = dateB.getTime();

                // Categoriza cada boleto: 1=vencido, 2=mês atual, 3=futuro
                const getCategory = (date) => {
                    if (date < now) return 1; // Vencido
                    const month = date.getMonth();
                    const year = date.getFullYear();
                    if (year === currentYear && month === currentMonth) return 2; // Mês atual
                    return 3; // Futuro
                };

                const catA = getCategory(dateA);
                const catB = getCategory(dateB);

                // Primeiro ordena por categoria (vencido < atual < futuro)
                if (catA !== catB) {
                    return catA - catB;
                }

                // Dentro da mesma categoria, ordena do mais recente para o mais antigo
                return timeB - timeA;
            })[0];

            // Guarda contexto do usuário (clientId, serviceId, billId)
            this.userStates.set(chatId, {
                clientId: cli.id,
                serviceId: activeService.id,
                billId: latest.id,
                clientName: cli?.nome || 'cliente',
                lastActivity: Date.now()
            });

            // PERGUNTA se quer PIX ou BOLETO
            const paymentOptionMsg = `*CPF CONFIRMADO: ${cli?.nome || 'Cliente'}*

Como você deseja pagar?

*1️⃣ PIX* (ou digite *pix*)

*2️⃣ BOLETO*

⏱️ *Liberação em até 5 minutos após o pagamento*

———
Digite o *número* da opção ou *8* para voltar ao menu.`;

            // Atualiza contexto: aguardando escolha PIX ou boleto
            this.setConversationContext(chatId, {
                currentMenu: 'payment',
                currentStep: 'waiting_payment_option'
            });

            await this.sendText(chatId, paymentOptionMsg);
            return;

        } catch (e) {
            // Se é erro de "cliente não encontrado", trata diferente (não é problema de API)
            if (e?.message && e.message.includes('Nenhum cliente encontrado')) {
                console.error(`🔍 [${chatId}] Cliente não encontrado para CPF`);
                await this.sendText(chatId, 'CPF não encontrado. Verifique o número e envie novamente.\n———\nDigite *8* para voltar ao menu.');
                return;
            }
            
            // Para outros erros, usa função de detecção de tipo de erro
            const errorInfo = this.getApiErrorMessage(e);
            console.error(`❌ [${chatId}] Erro ao buscar cliente por CPF:`, errorInfo.logMessage);
            console.error(`❌ [${chatId}] Detalhes:`, e?.message || e);
            if (e?.stack) console.error(`❌ [${chatId}] Stack trace:`, e.stack);
            
            await this.sendText(chatId, errorInfo.userMessage);
            return;
        }
    }

    getConversationContext(chatId) {
        const context = this.conversationContext.get(chatId);
        if (!context) {
            return { currentMenu: 'main', currentStep: null, lastActivity: Date.now() };
        }
        // NÃO atualiza lastActivity sempre que acessa - só quando há interação real
        // Isso evita que contexto nunca expire durante testes
        return context;
    }

    setConversationContext(chatId, context) {
        const existing = this.conversationContext.get(chatId) || {};
        this.conversationContext.set(chatId, {
            ...existing,
            currentMenu: context.currentMenu || existing.currentMenu || 'main',
            currentStep: context.currentStep !== undefined ? context.currentStep : existing.currentStep,
            ignoreUntilMenu: context.ignoreUntilMenu !== undefined ? context.ignoreUntilMenu : existing.ignoreUntilMenu,
            lastActivity: Date.now(),
            updatedAt: Date.now()
        });
    }

    async ensureSocket() {
        if (!this.sock) {
            throw new Error('Bot Baileys não está conectado');
        }
    }

    // Funções de pausa removidas - não usamos painel agora

    // Limpeza automática de contextos antigos (inativos há 1+ hora)
    cleanupOldContexts() {
        try {
            const now = Date.now();
            const maxAge = 60 * 60 * 1000; // 1 hora (aumentado de 30 min para não ser agressivo)
            
            for (const [chatId, context] of this.conversationContext.entries()) {
                const lastActivity = context.lastActivity || context.updatedAt || 0;
                if (now - lastActivity > maxAge) {
                    this.conversationContext.delete(chatId);
                    console.log(`🧹 Contexto limpo automaticamente para ${chatId} (inativo há ${Math.floor((now - lastActivity) / 60000)} minutos)`);
                }
            }
        } catch (e) {
            console.error('❌ Erro ao limpar contextos antigos:', e);
        }
    }

    // Limpa contexto manualmente de um chat específico
    clearContextForChat(chatId) {
        try {
            const hadContext = this.conversationContext.has(chatId);
            const hadUserState = this.userStates.has(chatId);
            
            this.conversationContext.delete(chatId);
            this.userStates.delete(chatId);
            
            console.log(`🧹 Contexto limpo manualmente para ${chatId}`);
            return { 
                success: true, 
                clearedContext: hadContext,
                clearedUserState: hadUserState
            };
        } catch (e) {
            console.error(`❌ Erro ao limpar contexto de ${chatId}:`, e);
            return { success: false, error: e.message };
        }
    }

    // Limpa todos os contextos (útil para testes)
    clearAllContexts() {
        try {
            const contextCount = this.conversationContext.size;
            const userStateCount = this.userStates.size;
            
            this.conversationContext.clear();
            this.userStates.clear();
            
            console.log(`🧹 Todos os contextos limpos (${contextCount} contextos, ${userStateCount} userStates)`);
            return { 
                success: true, 
                clearedContexts: contextCount,
                clearedUserStates: userStateCount
            };
        } catch (e) {
            console.error('❌ Erro ao limpar todos os contextos:', e);
            return { success: false, error: e.message };
        }
    }

    // Limpeza automática de userStates antigos (inativos há 1+ hora)
    cleanupOldUserStates() {
        try {
            const now = Date.now();
            const maxAge = 60 * 60 * 1000; // 1 hora
            
            for (const [chatId, state] of this.userStates.entries()) {
                const lastActivity = state.lastActivity || 0;
                if (now - lastActivity > maxAge) {
                    this.userStates.delete(chatId);
                    console.log(`🧹 UserState limpo para ${chatId} (inativo há ${Math.floor((now - lastActivity) / 60000)} minutos)`);
                }
            }
        } catch (e) {
            console.error('❌ Erro ao limpar userStates antigos:', e);
        }
    }

    // Limpeza automática de rate limiting antigo
    cleanupRateLimiting() {
        try {
            const now = Date.now();
            const maxAge = 5 * 60 * 1000; // 5 minutos
            
            for (const [chatId, lastResponse] of this.lastResponseTime.entries()) {
                if (now - lastResponse > maxAge) {
                    this.lastResponseTime.delete(chatId);
                }
            }
        } catch (e) {
            console.error('❌ Erro ao limpar rate limiting:', e);
        }
    }

    // Validação completa de CPF (dígitos verificadores)
    validateCPF(cpf) {
        if (!cpf || cpf.length !== 11) return false;
        
        // Remove caracteres não numéricos
        const cleanCpf = cpf.replace(/\D/g, '');
        if (cleanCpf.length !== 11) return false;
        
        // Verifica se todos os dígitos são iguais (CPF inválido)
        if (/^(\d)\1{10}$/.test(cleanCpf)) return false;
        
        // Valida primeiro dígito verificador
        let sum = 0;
        for (let i = 0; i < 9; i++) {
            sum += parseInt(cleanCpf.charAt(i)) * (10 - i);
        }
        let digit = 11 - (sum % 11);
        if (digit >= 10) digit = 0;
        if (digit !== parseInt(cleanCpf.charAt(9))) return false;
        
        // Valida segundo dígito verificador
        sum = 0;
        for (let i = 0; i < 10; i++) {
            sum += parseInt(cleanCpf.charAt(i)) * (11 - i);
        }
        digit = 11 - (sum % 11);
        if (digit >= 10) digit = 0;
        if (digit !== parseInt(cleanCpf.charAt(10))) return false;
        
        return true;
    }

    async getProfilePicUrl(chatId) {
        await this.ensureSocket();
        try {
            const jid = this.normalizeChatId(chatId);
            return await this.sock.profilePictureUrl(jid, 'image');
        } catch (e) {
            return null;
        }
    }

    async getLastQr() {
        if (!this.qrString) return null;
        try {
            const buffer = await qrcode.toBuffer(this.qrString);
            return {
                contentType: 'image/png',
                buffer
            };
        } catch (e) {
            return null;
        }
    }

    async reconnect() {
        try {
            console.log('🔄 Solicitando reconexão Baileys...');
            this.reconnectRequested = true;
            await this.stop();
            await new Promise(resolve => setTimeout(resolve, 2000));
            await this.start();
            this.reconnectRequested = false;
            return { success: true, message: 'Baileys reconectado', reconnected: true };
        } catch (e) {
            console.error('❌ Falha ao reconectar Baileys:', e);
            return { success: false, message: e.message || 'Erro ao reconectar', reconnected: false };
        }
    }

    async pause() {
        try {
            console.log('⏸️ Pausando Baileys...');
            this.pauseRequested = true;
            await this.stop();
            return { success: true, message: 'Baileys pausado' };
        } catch (e) {
            console.error('❌ Falha ao pausar Baileys:', e);
            return { success: false, message: e.message || 'Erro ao pausar' };
        }
    }

    async resume() {
        try {
            console.log('▶️ Retomando Baileys...');
            this.pauseRequested = false;
            if (!this.started) {
                await this.start();
                return { success: true, message: 'Baileys retomado' };
            }
            return { success: false, message: 'Baileys já está ativo' };
        } catch (e) {
            console.error('❌ Falha ao retomar Baileys:', e);
            return { success: false, message: e.message || 'Erro ao retomar' };
        }
    }

    async stop() {
        try {
            if (this.sock?.ev) {
                this.sock.ev.removeAllListeners('connection.update');
                this.sock.ev.removeAllListeners('creds.update');
                this.sock.ev.removeAllListeners('messages.upsert');
            }
            if (this.sock?.ws) {
                this.sock.ws.close();
            }
        } catch (e) {
            console.error('⚠️ Erro ao fechar socket Baileys:', e);
        } finally {
            this.sock = null;
            this.client = null;
            this.started = false;
        }
    }
}

module.exports = BaileysBot;

