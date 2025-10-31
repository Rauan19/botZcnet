// Bot baseado em wppconnect
// Objetivos atendidos:
// - Não marcar mensagens como lidas automaticamente (readMessages: false)
// - Não aparecer como online/digitando/gravação (markOnlineAvailable/markOnlineStatus: false)
// - Receber mensagens normalmente e responder com client.sendText
// - Código limpo, comentado e fácil de manter
// - Sem banco de dados: apenas logs e resposta simples
// - Opções do wppconnect conforme solicitado

const wppconnect = require('@wppconnect-team/wppconnect');
const zcBillService = require('./services/zcBillService');
const zcClientService = require('./services/zcClientService');
const messageStore = require('./database');
const contextAnalyzer = require('./services/contextAnalyzer');
const audioTranscription = require('./services/audioTranscription');
const audioSynthesis = require('./services/audioSynthesis');
const fs = require('fs');
const path = require('path');

class WhatsAppBot {
    constructor() {
        this.client = null; // Instância do cliente wppconnect
        this.started = false;
        this.userStates = new Map(); // guarda último contexto por usuário (clientId, serviceId, billId)
        this.lastQrBase64 = null; // Guarda último QR em base64 (data URL)
        this.humanAttending = new Map(); // guarda chats onde atendimento humano está ativo (chatId -> true/false)
        this.processedMessages = new Map(); // cache de mensagens processadas para evitar duplicação (messageId -> timestamp)
        this.userResponseRate = new Map(); // controle de rate limiting por usuário (chatId -> {lastResponse, count})
        
        // Limpeza automática de cache a cada 10 minutos
        setInterval(() => this.cleanupCache(), 10 * 60 * 1000);
    }

    /**
     * Mata processos órfãos do Chrome/Puppeteer
     */
    async killOrphanBrowsers() {
        try {
            const { exec } = require('child_process');
            const path = require('path');
            const userDataDir = path.join(__dirname, 'tokens', 'zcnet-bot');
            
            return new Promise((resolve) => {
                // Windows: mata processos Chrome que estão usando o userDataDir
                const command = process.platform === 'win32'
                    ? `taskkill /F /IM chrome.exe /FI "WINDOWTITLE eq *${userDataDir}*" 2>nul || taskkill /F /IM chrome.exe 2>nul`
                    : `pkill -f "chrome.*${userDataDir}" || true`;
                
                exec(command, (error) => {
                    if (error && !error.message.includes('not found') && !error.message.includes('no matching')) {
                        console.log('⚠️ Alguns processos podem estar em execução.');
                    } else {
                        console.log('🧹 Processos órfãos removidos.');
                    }
                    resolve();
                });
            });
        } catch (e) {
            console.log('⚠️ Não foi possível limpar processos órfãos.');
        }
    }

    /**
     * Inicia o bot criando a sessão wppconnect com as opções pedidas.
     */
    async start() {
        if (this.started) return;

        console.log('🔄 Iniciando bot WhatsApp (wppconnect)...');

        // Limpa processos órfãos antes de iniciar (opcional via env)
        if (process.env.KILL_ORPHAN_BROWSERS === '1') {
            await this.killOrphanBrowsers();
        }

        this.client = await wppconnect.create({
            session: 'zcnet-bot',
            catchQR: (base64Qr, asciiQR, attempt, urlCode) => {
                try {
                    this.lastQrBase64 = base64Qr; // "data:image/png;base64,...."
                    if (asciiQR) console.log(asciiQR);
                } catch (_) {}
            },
            // Impede fechar sozinho após login/QR
            autoClose: 0,
            // Não derruba/fecha navegador/cliente em eventos de logout
            browserCloseOnLogout: false,
            killClientOnLogout: false,
            disableWelcome: true,
            readMessages: false, // NUNCA marcar como lida automaticamente
            autoStatusResponse: false,
            headless: true,
            markOnlineAvailable: false,
            markOnlineStatus: false,
            logQR: true,
            useChrome: true,
            debug: false,
            // Logs de status da sessão (apenas para acompanhamento)
            statusFind: (statusSession, session) => {
                console.log(`ℹ️ Sessão: ${session} | Status: ${statusSession}`);
            },
            // Alguns ajustes de navegador para estabilidade
            browserArgs: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-extensions',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding'
            ],
            // Usa o Chrome do sistema se disponível (evita download do Puppeteer)
            puppeteerOptions: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu'
                ],
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
            }
        });

        this.setupListeners();

        this.started = true;
        console.log('✅ Bot WhatsApp conectado com sucesso (wppconnect)!');
        console.log('👻 Invisível e sem leitura automática configurado.');

        // Injeção inicial para bloquear leituras
        try { await this.injectNoRead(); } catch (_) {}
        // Reaplica bloqueios periodicamente (caso o WebApp recarregue módulos)
        if (!this._reinjectTicker) {
            this._reinjectTicker = setInterval(() => {
                this.injectNoRead().catch(() => {});
            }, 5000);
        }
    }

    /**
     * Retorna o último QR capturado (Buffer e contentType) ou null
     */
    getLastQr() {
        if (!this.lastQrBase64 || typeof this.lastQrBase64 !== 'string') return null;
        const m = this.lastQrBase64.match(/^data:(.*?);base64,(.*)$/);
        if (!m) return null;
        const contentType = m[1] || 'image/png';
        const buf = Buffer.from(m[2], 'base64');
        return { contentType, buffer: buf };
    }

    /**
     * Registra listeners do cliente.
     */
    setupListeners() {
        const client = this.client;

        // Conexão/estado é tratado via onStateChange

        // Mudança de estado do cliente
        client.onStateChange(async (state) => {
            console.log(`🔁 Estado do cliente: ${state}`);
            // Reaplica bloqueio de leitura ao entrar em estados principais
            if (String(state).toUpperCase().includes('MAIN') || String(state).toUpperCase().includes('CONNECTED')) {
                try { await this.injectNoRead(); } catch (_) {}
            }
            // Watchdog: se desconectar ou ficar desemparelhado, recria a sessão
            const critical = ['DISCONNECTED', 'UNPAIRED', 'UNPAIRED_IDLE'];
            if (critical.includes(String(state).toUpperCase())) {
                try {
                    console.log('🧯 Detected session drop. Restarting client in 3s...');
                    await this.stop();
                } catch (_) {}
                setTimeout(() => {
                    this.start().catch((e) => console.error('❌ Falha ao reiniciar cliente:', e));
                }, 3000);
            }
        });

        // Fluxo/Interface (para depurar recebimento de mensagens)
        client.onStreamChange((stream) => {
            console.log(`📶 Stream: ${stream}`);
        });
        client.onInterfaceChange((change) => {
            console.log(`🖥️ Interface: ${JSON.stringify(change)}`);
        });

        // Recebimento de mensagens
        client.onMessage(async (message) => {
            try {
                // Verificação de duplicação: ignora mensagem se já foi processada
                const messageId = message.id;
                if (this.isMessageProcessed(messageId)) {
                    return; // Mensagem já processada, ignora silenciosamente
                }
                
                // Marca mensagem como processada (guarda por 10 minutos)
                this.processedMessages.set(messageId, Date.now());
                
                // Rate limiting: evita spam de respostas
                if (!this.checkRateLimit(message.from)) {
                    return; // Rate limit atingido, ignora silenciosamente
                }
                
                console.log('📥 onMessage bruto:', JSON.stringify({ from: message.from, isGroupMsg: message.isGroupMsg, body: message.body }));
                // Ignora grupos: bot atende só conversas privadas
                if (message.isGroupMsg) {
                    console.log('🤖 Mensagem de grupo ignorada (bot atende apenas conversas privadas).');
                    return;
                }
                
                // Ignora mensagens de status (stories/status do WhatsApp)
                if (message.isStatus === true || message.from === 'status@broadcast' || 
                    message.from?.includes('status') || message.isStory || message.type === 'status') {
                    console.log('📊 Mensagem de story/status ignorada.');
                    return;
                }
                
                // Ignora mensagens de números verificados (bancos, caixas, etc.)
                if (message.sender?.verified) {
                    console.log('🏢 Mensagem de número verificado ignorada.');
                    return;
                }

                // Direção da mensagem: se foi enviada pelo próprio número (atendente/WhatsApp), registra como "out"
                const body = message.body || '';
                const isFromMe = message.fromMe === true || message.sender?.isMe === true;
                if (isFromMe) {
                    // IGNORA mensagens com base64 longo (provavelmente confirmação de envio de arquivo)
                    // Quando enviamos PDF/QR code, o WhatsApp retorna mensagem com base64 que não queremos registrar
                    if (this.isBase64String(body)) {
                        console.log('📊 Mensagem com base64 ignorada (confirmação de envio de arquivo).');
                        return;
                    }
                    
                    // Mensagem enviada pelo nosso número; identificar o chat correto
                    // IMPORTANTE: Para mensagens enviadas por nós, o chatId está em message.to ou message.chatId
                    let targetChatId = message.to || message.chatId || message.from;
                    
                    // Garante formato correto do chatId
                    if (!targetChatId.includes('@')) {
                        targetChatId = targetChatId.includes('-') ? targetChatId : `${targetChatId}@c.us`;
                    }
                    
                    // Detecta se atendente humano se identificou na mensagem
                    const bodyLower = body.toLowerCase();
                    const isAttendantIdentification = this.detectAttendantIdentification(bodyLower);
                    console.log(`🔍 Verificando se é atendente: texto="${bodyLower}" → detectAttendantIdentification=${isAttendantIdentification}`);
                    
                    if (isAttendantIdentification) {
                        // Atendente se identificou - desativa bot IMEDIATAMENTE para este chat
                        this.humanAttending.set(targetChatId, true);
                        console.log(`👤 Atendente humano identificado para chat ${targetChatId}. Bot PAUSADO imediatamente para esta conversa.`);
                    }
                    
                    // Verifica se atendente quer reativar o bot (comando secreto)
                    if (bodyLower.includes('#reativar') || bodyLower.includes('#boton') || bodyLower.includes('#bot on')) {
                        this.humanAttending.set(targetChatId, false);
                        console.log(`🤖 Bot reativado para chat ${targetChatId}.`);
                    }
                    
                    try {
                        messageStore.recordOutgoingMessage({ chatId: targetChatId, text: body, timestamp: Date.now() });
                    } catch (_) {}
                    return; // não processa automações para mensagens nossas
                }

                // Detecta se é mensagem de áudio
                let finalBody = body;
                const isAudio = message.mimetype && message.mimetype.includes('audio');
                let clientSentAudio = false; // Flag para saber se cliente enviou áudio
                
                if (isAudio && !message.fromMe) {
                    clientSentAudio = true; // Cliente enviou áudio
                    // Cliente enviou áudio - transcreve para texto
                    console.log('🎤 Áudio recebido, transcrevendo...');
                    try {
                        const transcript = await audioTranscription.processWhatsAppAudio(message, client);
                        if (transcript && transcript.trim()) {
                            finalBody = transcript;
                            console.log(`✅ Áudio transcrito: "${transcript}"`);
                            
                            // Salva transcrição como mensagem de áudio no banco
                            try {
                                const audioId = message.id || `audio_${Date.now()}`;
                                messageStore.recordIncomingMessage({ 
                                    chatId: message.from, 
                                    sender: message.from, 
                                    text: '[áudio]', 
                                    timestamp: Date.now(), 
                                    name: message.sender?.pushname || '',
                                    audioId 
                                });
                                
                                // Salva transcrição como mensagem separada
                                messageStore.recordIncomingMessage({ 
                                    chatId: message.from, 
                                    sender: message.from, 
                                    text: `(Transcrição): ${transcript}`, 
                                    timestamp: Date.now() + 1, // +1ms para aparecer depois
                                    name: message.sender?.pushname || '' 
                                });
                            } catch (_) {}
                        } else {
                            console.log('⚠️ Transcrição não disponível, processando áudio normalmente');
                            finalBody = '[áudio]';
                        }
                    } catch (e) {
                        console.error('❌ Erro ao transcrever áudio:', e);
                        finalBody = '[áudio]';
                    }
                }
                
                console.log(`📩 Mensagem recebida de ${message.from}: ${finalBody || '[sem texto]'}`);
                // Registrar no painel (incrementa não lidas) - só se não for áudio (já registrado acima)
                if (!isAudio || finalBody === '[áudio]') {
                    try { messageStore.recordIncomingMessage({ chatId: message.from, sender: message.from, text: finalBody, timestamp: Date.now(), name: message.sender?.pushname || '' }); } catch (_) {}
                }
                
                // DETECTA SE CLIENTE FALOU QUE VAI FALAR COM ATENDENTE OU JÁ FALOU COM ATENDENTE
                // Pausa bot IMEDIATAMENTE
                const finalBodyLower = finalBody.toLowerCase();
                const hasAttendantKeyword = finalBodyLower.includes('atendente') || finalBodyLower.includes('atendende');
                if (hasAttendantKeyword) {
                    // Cliente mencionou atendente - pausa bot para este chat
                    this.humanAttending.set(message.from, true);
                    console.log(`👤 Cliente mencionou atendente - bot pausado: "${finalBody.substring(0, 50)}..."`);
                    return; // Para IMEDIATAMENTE, não processa mais nada
                }
                
                // Filtro de mensagens de sistema (evita responder códigos/confirm.
                if (this.isSystemMessage(body)) {
                    console.log('⚠️ Mensagem de sistema ignorada.');
                return;
            }

                // Detecta CPF/documento (11+ dígitos) e envia boleto mais recente
                const doc = this.extractDocument(body);
                if (doc) {
                    // Não envia mensagem de status - busca direto para ser mais rápido e silencioso
                    try {
                        // Busca cliente e serviços
                        const cli = await zcClientService.getClientByDocument(doc);
                        const services = await zcClientService.getClientServices(cli.id);
                        if (!services || services.length === 0) {
                            const out = '*❌ CLIENTE ENCONTRADO MAS SEM SERVIÇOS ATIVOS*';
                            // Responde sempre com áudio quando é sobre pagamento/internet
                            await this.sendAudioResponse(message.from, 
                                'Cliente encontrado mas sem serviços ativos.',
                                true
                            );
                return;
            }
                        const activeService = services.find(s => s.status === 'ativo') || services[0];

                        // Busca contas e escolhe a mais recente
                        const bills = await zcBillService.getBills(cli.id, activeService.id, 'INTERNET');
                        if (!bills || bills.length === 0) {
                            const out = '*❌ NENHUMA COBRANÇA ENCONTRADA PARA ESTE CLIENTE*';
                            // Responde sempre com áudio quando é sobre pagamento/internet
                            await this.sendAudioResponse(message.from, 
                                'Nenhuma cobrança encontrada para este cliente.',
                                true
                            );
                return;
            }
                        const latest = bills.sort((a, b) => new Date(b.data_vencimento || b.vencimento) - new Date(a.data_vencimento || a.vencimento))[0];

                        // Guarda contexto do usuário para PIX posterior
                        this.userStates.set(message.from, {
                            clientId: cli.id,
                            serviceId: activeService.id,
                            billId: latest.id,
                            clientName: cli?.nome || 'cliente',
                            lastActivity: Date.now() // Para limpeza automática
                        });

                        // Gera PDF do boleto
                        const pdfPath = await zcBillService.generateBillPDF(cli.id, activeService.id, latest.id);
                            const caption = `*📄 BOLETO DE ${cli?.nome || 'cliente'}*\n\n*Se preferir pagar com PIX responda pix*`;
                            
                            // SEMPRE responde com áudio quando é sobre pagamento/internet
                            await this.sendAudioResponse(message.from, 
                                `Boleto de ${cli?.nome || 'cliente'}. Se preferir pagar com PIX responda pix.`,
                                true
                            );
                            
                            // Envia o PDF do boleto
                            await this.sendKeepingUnread(() => client.sendFile(message.from, pdfPath, 'boleto.pdf', caption), message.from);

                            // Salva uma cópia do PDF para o painel e registra metadados
                            try {
                                const path = require('path');
                                const fs = require('fs');
                                const filesDir = path.join(__dirname, 'files');
                                if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
                                const fileId = `boleto_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`;
                                const destPath = path.join(filesDir, fileId);
                                fs.copyFileSync(pdfPath, destPath);
                                messageStore.recordOutgoingMessage({
                                    chatId: message.from,
                                    text: caption, // Remove [arquivo] e mantém só o texto limpo
                                    timestamp: Date.now(),
                                    fileId,
                                    fileName: 'boleto.pdf',
                                    fileType: 'application/pdf'
                                });
                            } catch (_) {
                                try { messageStore.recordOutgoingMessage({ chatId: message.from, text: '[arquivo] boleto.pdf - ' + caption, timestamp: Date.now() }); } catch (_) {}
                            }
                            
                            // PAUSA O BOT após enviar boleto (cliente tem que pagar primeiro)
                            this.humanAttending.set(message.from, true);
                            console.log(`⏸️ Bot pausado para chat ${message.from} após enviar boleto. Cliente deve realizar pagamento.`);
                            
                            return;
                    } catch (e) {
                        console.error('Erro ao buscar boleto por documento:', e?.message || e);
                        
                        // Tratamento de erros específicos
                        let errorMessage = 'Não encontrei boleto. Confira o CPF somente números ou envie menu.';
                        if (e?.message && e.message.includes('timeout')) {
                            errorMessage = 'O servidor demorou para responder. Tente novamente em instantes.';
                        } else if (e?.message && e.message.includes('Nenhum cliente encontrado')) {
                            errorMessage = 'CPF não encontrado. Verifique e envie novamente.';
                        }
                        
                        // Responde sempre com áudio quando é sobre pagamento/internet
                        await this.sendAudioResponse(message.from, 
                            errorMessage,
                            true
                        );
                return;
            }
                }

                // Comandos simples e palavras-chave (usa texto transcrito se for áudio)
                const text = finalBody.trim();
                
            // Analisa intenção da mensagem com contexto de múltiplas mensagens
            let contextResult;
            try {
                contextResult = await contextAnalyzer.analyzeContext(message.from, text);
                console.log(`🧠 Análise de contexto: intent=${contextResult.intent}, confidence=${contextResult.confidence.toFixed(2)}, mensagens=${contextResult.messagesCount}`);
            } catch (e) {
                console.error('Erro ao analisar contexto, usando análise simples:', e);
                // Fallback para análise simples se NLP falhar
                contextResult = {
                    intent: this.analyzePaymentIntent(text),
                    confidence: 0.5,
                    messagesCount: 1
                };
            }
            
            const intent = contextResult.intent;
            const textLower = text.toLowerCase();
            
            // VERIFICAÇÃO: Se atendimento humano está ativo, verifica se cliente quer reativar
            // EXCEÇÃO: solicitações de pagamento SEMPRE reativam o bot
            const isPaymentRequest = intent === 'request_payment';
            const textCheck = text.trim().toLowerCase();
            const isPaymentCommand = textCheck.includes('pix') || textCheck.includes('menu') || textCheck.match(/^\d{11,14}$/);
            
            if (this.humanAttending.get(message.from) === true) {
                if (isPaymentCommand || isPaymentRequest) {
                    // Cliente quer pagar - reativa bot
                    console.log(`🤖 Cliente solicitou pagamento - reativando bot para atendimento automático.`);
                    this.humanAttending.set(message.from, false);
                    // Continua o fluxo normalmente abaixo para processar solicitação
                } else {
                    // Não é solicitação de pagamento - ignora
                    console.log(`💬 Chat ${message.from} está em atendimento humano - bot ignorando mensagens do cliente.`);
                    // Registra mensagem do cliente mas NÃO responde
                    try {
                        messageStore.recordIncomingMessage({ 
                            chatId: message.from, 
                            sender: message.from, 
                            text: text, 
                            timestamp: Date.now(), 
                            name: message.sender?.pushname || '' 
                        }); 
                    } catch (_) {}
                    return; // Não responde - atendimento humano ativo
                }
            }
            
            // 1. Confirmação de pagamento feito - NÃO responde nada, apenas pausa
            if (intent === 'confirm_payment') {
                // Quando cliente confirma pagamento, bot NÃO responde - apenas pausa para atendente humano
                console.log(`💬 Cliente confirmou pagamento - bot pausado sem resposta: "${text.substring(0, 50)}..."`);
                this.humanAttending.set(message.from, true);
                return; // Não responde nada
            }
            
            // 2. Cliente informando que vai pagar presencialmente (ignorar E pausar bot)
            // VERIFICA ANTES de checar se bot está pausado - prioridade máxima
            if (intent === 'inform_presential') {
                console.log(`💬 Cliente informando pagamento presencial - mensagem ignorada e bot pausado: "${text}"`);
                // Pausa o bot para este chat - cliente vai pagar pessoalmente, não precisa de mais nada
                this.humanAttending.set(message.from, true);
                // Registra mensagem do cliente mas não responde
                try {
                    messageStore.recordIncomingMessage({ 
                        chatId: message.from, 
                        sender: message.from, 
                        text: text, 
                        timestamp: Date.now(), 
                        name: message.sender?.pushname || '' 
                    }); 
                } catch (_) {}
                return; // Não responde - cliente não quer boleto/PIX
            }
            
            // 3. Se intenção não clara (unclear), verifica se é problema relacionado a pagamento
            // Se tiver palavras de pagamento E problema, pausa bot para atendimento humano
            if (intent === 'unclear') {
                const hasPaymentWord = ['paguei', 'pago', 'pagamento', 'paguei', 'fiz o pagamento'].some(kw => textLower.includes(kw));
                const hasProblem = [
                    'ainda n', 'ainda não', 'ainda nao', 'ainda não liberou', 'ainda nao liberou',
                    'não liberou', 'nao liberou', 'n liberou', 'não funciona', 'nao funciona',
                    'n funciona', 'não voltou', 'nao voltou', 'n voltou', 'problema', 'erro'
                ].some(pi => textLower.includes(pi));
                
                // Se tem pagamento E problema, pausa bot e não responde
                if (hasPaymentWord && hasProblem) {
                    console.log(`⚠️ Cliente reportou pagamento com problema - bot pausado: "${text.substring(0, 50)}..."`);
                    this.humanAttending.set(message.from, true);
                    return; // Não responde nada
                }
                
                // Caso contrário, ignora normalmente
                console.log(`💬 Intenção não clara, mensagem ignorada (conversa normal): "${text.substring(0, 50)}..."`);
                return;
            }
            
            // 4. Solicitação clara de boleto/PIX - processa comandos
            // Continua o fluxo abaixo para processar solicitação
            if (textLower === 'menu' || textLower.includes('menu')) {
                const out = this.menuTexto();
                // Responde sempre com áudio quando é sobre pagamento/internet
                await this.sendAudioResponse(message.from, 
                    'Menu de opções. Envie seu CPF apenas números para receber o boleto em PDF. Escreva pix para instruções de PIX.',
                    true
                );
                return;
            }
            
            if (textLower.includes('pix')) {
                const ctx = this.userStates.get(message.from);
                if (!ctx) {
                    const out = '🤖 *PARA GERAR O PIX*\n\nEnvie seu *CPF* (somente números).';
                    // Responde sempre com áudio quando é sobre pagamento/internet
                    await this.sendAudioResponse(message.from, 
                        'Para gerar o PIX, preciso do seu CPF apenas números.',
                        true
                    );
                    return;
                }
                try {
                    // Não envia mensagem de status - gera direto para ser mais rápido e silencioso
                    const pix = await zcBillService.generatePixQRCode(ctx.clientId, ctx.serviceId, ctx.billId);
                    const parsed = this.parsePixPayload(pix);
                    
                    if (parsed.imageBase64) {
                        // SEMPRE responde com áudio quando é sobre pagamento/internet
                        await this.sendAudioResponse(message.from, 
                            'QR code PIX. Escaneie para pagar via PIX.',
                            true
                        );
                        
                        // Envia a imagem do QR code
                        await this.sendKeepingUnread(() => client.sendImageFromBase64(message.from, parsed.imageBase64, 'pix.png', '*🔵 QRCODE PIX*\n\n*ESCANEIE PARA PAGAR VIA PIX*'), message.from);
                        
                        // Salva QR code como arquivo de imagem para exibição no painel
                        try {
                            const path = require('path');
                            const fs = require('fs');
                            const filesDir = path.join(__dirname, 'files');
                            if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
                            
                            // Remove prefixo data URL se existir
                            let base64Data = parsed.imageBase64;
                            if (typeof base64Data === 'string' && base64Data.includes(',')) {
                                base64Data = base64Data.split(',')[1];
                            }
                            
                            const imageBuffer = Buffer.from(base64Data, 'base64');
                            const fileId = `qrcode_${Date.now()}_${Math.random().toString(36).slice(2)}.png`;
                            const destPath = path.join(filesDir, fileId);
                            fs.writeFileSync(destPath, imageBuffer);
                            
                            messageStore.recordOutgoingMessage({
                                chatId: message.from,
                                text: '🔵 QRCode PIX',
                                timestamp: Date.now(),
                                fileId,
                                fileName: 'qrcode-pix.png',
                                fileType: 'image/png'
                            });
                        } catch (_) {
                            // Fallback: salva sem arquivo
                            try { messageStore.recordOutgoingMessage({ chatId: message.from, text: '[imagem] QRCode PIX', timestamp: Date.now() }); } catch (_) {}
                        }
                    }
                    if (parsed.payload) {
                        // Envia mensagem informativa primeiro
                        const infoMsg = '*🔗 COPIA E COLA PIX:*';
                        // Responde sempre com áudio quando é sobre pagamento/internet
                        await this.sendAudioResponse(message.from, 
                            'Copia o código abaixo e cole no seu banco para efetuar o pagamento',
                            true
                        );
                        
                        // Aguarda um pouco antes de enviar o código
                        await new Promise(resolve => setTimeout(resolve, 500));
                        
                        // Envia o código em outra mensagem (só texto, não precisa áudio para código)
                        await this.sendKeepingUnread(() => client.sendText(message.from, parsed.payload), message.from);
                        try { messageStore.recordOutgoingMessage({ chatId: message.from, text: parsed.payload }); } catch (_) {}
                    }
                    if (!parsed.imageBase64 && !parsed.payload) {
                        const out = '*⚠️ ERRO*\n\nPIX gerado, mas não recebi imagem nem payload utilizável da API.';
                        // Responde sempre com áudio quando é sobre pagamento/internet
                        await this.sendAudioResponse(message.from, 
                            'Erro! PIX gerado, mas não recebi imagem nem código utilizável da API.',
                            true
                        );
                        return;
                    }
                    
                    // DEPOIS DE ENVIAR O PIX, ENVIA MENSAGEM DE INSTRUÇÕES E PAUSA O BOT
                    // Aguarda um pouco para garantir que tudo foi enviado
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                    // Envia mensagem de instruções pós-pagamento
                    await this.sendAudioResponse(message.from, 
                        'Após realizar o pagamento, em até 5 minutos sua internet estará liberada automaticamente. Se sua internet não voltar, desligue e ligue novamente os equipamentos.',
                        true
                    );
                    
                    // PAUSA O BOT para este chat após enviar PIX
                    this.humanAttending.set(message.from, true);
                    console.log(`⏸️ Bot pausado para chat ${message.from} após enviar PIX. Cliente deve aguardar pagamento.`);
                    
                    return;
                } catch (e) {
                    console.error('Erro ao gerar PIX:', e?.message || e);
                    
                    // Tratamento de erros específicos
                    let errorMessage = 'Erro! Não consegui gerar o PIX agora. Tente novamente ou use o boleto em PDF.';
                    if (e?.message && e.message.includes('timeout')) {
                        errorMessage = 'O servidor demorou para gerar o PIX. Tente novamente em instantes.';
                    } else if (e?.message && e.message.includes('não encontrado')) {
                        errorMessage = 'Erro ao gerar PIX. Tente enviar seu CPF novamente.';
                    }
                    
                    // Responde sempre com áudio quando é sobre pagamento/internet
                    await this.sendAudioResponse(message.from, 
                        errorMessage,
                        true
                    );
                    return;
                }
            }

            // Resposta padrão quando há solicitação de pagamento mas não é comando específico
            // Só responde se realmente houver intenção de solicitar pagamento
            if (intent === 'request_payment') {
                const reply = '🤖 *OLÁ!*\n\nPara consultar seu boleto, envie seu *CPF* (apenas números).\n\nPara mais opções, envie "*menu*".';
                
                // SEMPRE responde com áudio quando é sobre pagamento/internet (mesmo se cliente enviou texto)
                await this.sendAudioResponse(message.from, 
                    'Olá! Para consultar seu boleto, envie seu CPF apenas números. Para mais opções, envie menu.',
                    true
                );
            }
            } catch (err) {
                console.error('❌ Erro ao processar mensagem:', err);
            }
        });

        // Eventos opcionais de sessão (removidos: onLogout/onRemoved não existem nesta API)

        // Listener extra para manter o processo sempre com eventos ativos
        client.onAnyMessage((m) => {
            try {
                // Ignora grupos
                if (m.isGroupMsg) return;
                // Ignora mensagens de status/stories
                if (m.isStatus === true || m.from === 'status@broadcast' || m.from?.includes('status') || 
                    m.isStory || m.type === 'status') return;
                // Se mensagem foi enviada pelo próprio WhatsApp (atendente no celular/WhatsApp Web)
                if (m.fromMe === true && typeof m.body === 'string' && m.body.trim().length > 0) {
                    // IGNORA mensagens com base64 longo (provavelmente confirmação de envio de arquivo)
                    if (this.isBase64String(m.body)) {
                        return; // Ignora silenciosamente
                    }
                    
                    // Evita duplicidade com mensagens já gravadas pelo painel/bot
                    const targetChatId = m.chatId || m.to || m.from;
                    const exists = messageStore.hasSimilarRecentOutgoing(targetChatId, m.body.trim(), 10000);
                    if (!exists) {
                        try { messageStore.recordOutgoingMessage({ chatId: targetChatId, text: m.body.trim(), timestamp: Date.now() }); } catch (_) {}
                    }
                }
            } catch (_) {}
        });

        // Verificador de conexão periódico (reduzido para não poluir logs)
        this.connectionTicker = setInterval(async () => {
            try {
                const connected = await client.isConnected();
                if (!connected) {
                    console.log(`⚠️ Conexão perdida! isConnected: ${connected}`);
                }
            } catch (e) {}
        }, 60000); // Agora verifica a cada 1 minuto
    }

    // ===== Utilidades de parsing/validação =====
    extractDocument(text) {
        if (!text) return null;
        const digits = (text.match(/\d/g) || []).join('');
        if (digits.length >= 11) {
            const doc = digits.slice(0, 14);
            // Valida CPF básico (11 dígitos) ou CNPJ (14 dígitos)
            if (doc.length === 11 || doc.length === 14) {
                return doc;
            }
        }
        return null;
    }

    isPaymentConfirmation(text) {
        if (!text) return false;
        const t = text.toLowerCase();
        const keywords = ['paguei', 'já paguei', 'ja paguei', 'pago', 'comprovante', 'quitado', 'já foi pago', 'ja foi pago'];
        return keywords.some(k => t.includes(k));
    }

    isSystemMessage(text) {
        if (!text) return false;
        const t = text.toLowerCase();
        const patterns = [
            'é seu código', 'codigo de confirmação', 'facebook', 'instagram', 'verificação', 'verification code', 'security code', 'otp', 'two-factor'
        ];
        return patterns.some(p => t.includes(p));
    }

    /**
     * Detecta se uma string contém base64 longo (provavelmente de arquivo enviado)
     * Ignora mensagens de confirmação do WhatsApp que contêm base64 de arquivos
     */
    isBase64String(text) {
        if (!text || typeof text !== 'string') return false;
        const trimmed = text.trim();
        
        // Verifica se é data URL (data:image/..., data:application/pdf;base64,...)
        if (/^data:[^;]+;base64,[A-Za-z0-9+\/=]+$/i.test(trimmed)) {
            return true;
        }
        
        // Verifica se é string base64 pura (mais de 100 caracteres, principalmente alfanuméricos)
        // Base64 típico: apenas A-Z, a-z, 0-9, +, /, = (com muitos caracteres)
        if (trimmed.length > 100) {
            // Conta caracteres base64 válidos
            const base64Chars = trimmed.match(/[A-Za-z0-9+\/=]/g) || [];
            const ratio = base64Chars.length / trimmed.length;
            
            // Se mais de 90% dos caracteres são base64 válidos e tem mais de 100 chars, provavelmente é base64
            if (ratio > 0.9 && trimmed.length > 100) {
                return true;
            }
        }
        
        return false;
    }

    /**
     * Analisa a intenção da mensagem do cliente relacionada a pagamento
     * Retorna: 'request_payment' (quer boleto/PIX), 'inform_presential' (vai pagar presencialmente), 
     *         'confirm_payment' (confirmou pagamento), 'unclear' (intenção não clara)
     */
    analyzePaymentIntent(text) {
        if (!text) return 'unclear';
        const t = text.toLowerCase().trim();
        
        // 1. Confirmação de pagamento já feito
        // MAS verifica se tem palavras que indicam PROBLEMA - se tiver, NÃO é confirmação simples
        const problemIndicators = [
            'ainda n', 'ainda não', 'ainda nao', 'ainda não liberou', 'ainda nao liberou',
            'não liberou', 'nao liberou', 'n liberou', 'não funciona', 'nao funciona',
            'n funciona', 'não voltou', 'nao voltou', 'n voltou', 'não caiu', 'nao caiu',
            'problema', 'erro', 'não deu certo', 'nao deu certo', 'n deu certo',
            'mas ainda', 'mas n', 'mas não', 'mas nao', 'porém ainda', 'porém não',
            'e ainda', 'e n', 'e não', 'e nao', 'mas não funciona', 'mas nao funciona'
        ];
        
        const hasProblem = problemIndicators.some(pi => t.includes(pi));
        
        // Se tem indicação de problema, NÃO é confirmação simples - deixa para atendente humano
        if (hasProblem) {
            return 'unclear'; // Não responde automaticamente
        }
        
        // Detecção de TODAS as variações possíveis de confirmação de pagamento
        const paymentDone = [
            // Formas diretas
            'paguei', 'já paguei', 'ja paguei', 'eu paguei', 'já foi pago', 'ja foi pago', 'foi pago',
            'paguei já', 'ja paguei', 'paguei agora', 'paguei hoje', 'paguei ontem', 'paguei hoje',
            // Com contexto
            'paguei a conta', 'paguei a fatura', 'paguei a internet', 'paguei o boleto', 'paguei o pix',
            'paguei conta', 'paguei fatura', 'paguei internet', 'paguei boleto', 'paguei pix',
            'cliente paguei', 'eu ja paguei', 'eu já paguei', 'eu paguei já',
            // Formas formais
            'fiz o pagamento', 'fiz pagamento', 'realizei o pagamento', 'realizei pagamento',
            'efetuei o pagamento', 'efetuei pagamento', 'já fiz o pagamento', 'ja fiz o pagamento',
            'já realizei o pagamento', 'ja realizei o pagamento', 'já efetuei o pagamento', 'ja efetuei o pagamento',
            // Estados
            'pago', 'está pago', 'esta pago', 'já está pago', 'ja esta pago', 'foi quitado', 'quitado',
            'pagamento feito', 'pagamento realizado', 'pagamento efetuado', 'pagamento confirmado',
            // Comprovantes
            'comprovante', 'enviei comprovante', 'mandei comprovante', 'tenho comprovante',
            'comprovante de pagamento', 'comprovante aqui', 'comprovante em mãos'
        ];
        // Verifica se a mensagem contém alguma dessas palavras/frases
        if (paymentDone.some(kw => t.includes(kw))) {
            return 'confirm_payment';
        }

        // 2. Informações sobre pagamento presencial (ignorar - cliente não quer boleto/PIX)
        const presentialPayment = [
            'vou passar aí', 'vou aí', 'passo aí', 'vou aí pagar', 'passo aí amanhã', 'amanhã passo aí',
            'amanhã vou aí', 'amanhã vou passar aí', 'amanhã passo aí pagar',
            'vou na loja', 'vou no estabelecimento', 'vou pagar pessoalmente',
            'vou no balcão', 'vou pagar na loja', 'vou pagar no estabelecimento',
            'amanhã vou pagar', 'depois vou pagar', 'vou pagar depois',
            'vou aí resolver', 'vou resolver aí', 'passo aí resolver',
            'quando eu for aí', 'quando eu passar aí', 'quando for aí',
            'depois passo aí', 'depois vou aí', 'depois vou passar aí',
            'vou aí amanhã', 'passo aí depois', 'vou resolver presencialmente',
            'vou pagar presencial', 'vou pagar presencialmente', 'vou resolver pessoalmente'
        ];
        if (presentialPayment.some(kw => t.includes(kw))) {
            return 'inform_presential';
        }

        // 3. Solicitações claras de boleto/PIX (cliente quer)
        const paymentRequests = [
            'quero pagar', 'preciso pagar', 'como pago', 'como faço para pagar',
            'manda boleto', 'envia boleto', 'quero boleto', 'preciso do boleto',
            'manda pix', 'envia pix', 'quero pix', 'preciso pix',
            'segunda via', '2ª via', '2a via', 'segunda via do boleto',
            'boleto por favor', 'pix por favor', 'envia o boleto', 'manda o boleto',
            'preciso pagar a internet', 'quero pagar a internet',
            'fatura por favor', 'conta por favor', 'preciso da fatura',
            'gerar boleto', 'gerar pix', 'gerar qrcode', 'gerar qr code'
        ];
        if (paymentRequests.some(kw => t.includes(kw))) {
            return 'request_payment';
        }

        // 4. Palavras relacionadas mas sem intenção clara - verifica contexto
        const paymentRelated = ['pagar', 'pagamento', 'boleto', 'fatura', 'conta', 'pix', 'vencimento', 'vencida'];
        const hasPaymentWord = paymentRelated.some(kw => t.includes(kw));
        
        // Se tem palavra relacionada mas sem verbos de ação claros, considera não claro
        // (provavelmente está apenas conversando sobre pagamento, não solicitando)
        if (hasPaymentWord) {
            // Verifica se tem verbos de solicitação
            const requestVerbs = ['quero', 'preciso', 'manda', 'envia', 'gostaria', 'poderia'];
            const hasRequestVerb = requestVerbs.some(v => t.includes(v));
            if (hasRequestVerb) {
                return 'request_payment';
            }
            // Se tem palavra de pagamento mas sem intenção clara, retorna unclear
            return 'unclear';
        }

        return 'unclear';
    }

    menuTexto() {
        return [
            '📋 *MENU DE OPÇÕES:*',
            '',
            '*1.* Envie seu *CPF* (somente números) para receber o boleto em PDF',
            '',
            '*2.* Escreva "*pix*" para instruções de PIX',
        ].join('\n');
    }

    // Interpreta diferentes formatos de retorno do endpoint PIX
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

    // ===== Envio mantendo conversa como NÃO lida =====
    async sendKeepingUnread(sendFn, chatId) {
        try {
            // Garante bloqueio de leitura antes de enviar
            try { await this.injectNoRead(); } catch (_) {}
            const result = await sendFn();
            // pequena espera e marca como não lida
            await this.sleep(150);
            try {
                if (this.client && typeof this.client.markUnseenMessage === 'function') {
                    await this.client.markUnseenMessage(chatId);
                }
            } catch {}
            return result;
        } catch (e) {
            throw e;
        }
    }

    /**
     * Envia resposta por áudio quando cliente enviou áudio
     * @param {string} chatId - ID do chat
     * @param {string} text - Texto para converter em áudio
     * @param {boolean} alsoSendText - Se true, também envia como texto
     */
    async sendAudioResponse(chatId, text, alsoSendText = true) {
        try {
            console.log(`🎤 Gerando resposta em áudio: "${text}"`);
            
            // Gera áudio com voz feminina natural (mais humana)
            const audioPath = await audioSynthesis.textToSpeechFemale(text);
            
            // Envia áudio
            await this.sendKeepingUnread(
                () => this.client.sendPtt(chatId, audioPath),
                chatId
            );
            
            // Salva no banco como mensagem de áudio
            try {
                const audioId = `audio_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                const audioDir = path.join(__dirname, 'audios');
                if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
                
                // Copia áudio para diretório de audios
                const audioDestPath = path.join(audioDir, `${audioId}.ogg`);
                fs.copyFileSync(audioPath, audioDestPath);
                
                messageStore.recordOutgoingMessage({
                    chatId: chatId,
                    text: '[áudio]',
                    timestamp: Date.now(),
                    audioId: audioId
                });
            } catch (_) {}
            
            // Se solicitado, também envia como texto
            if (alsoSendText) {
                await this.sendKeepingUnread(
                    () => this.client.sendText(chatId, text),
                    chatId
                );
                // Registra DEPOIS de enviar, mas o onAnyMessage vai verificar duplicação
                // Pequeno delay para garantir que o onAnyMessage já registrou ou não vai registrar
                setTimeout(() => {
                    try {
                        const exists = messageStore.hasSimilarRecentOutgoing(chatId, text, 10000);
                        if (!exists) {
                            messageStore.recordOutgoingMessage({ chatId: chatId, text: text, timestamp: Date.now() }); 
                        }
                    } catch (_) {}
                }, 500);
            }
        } catch (e) {
            console.error('❌ Erro ao enviar resposta em áudio:', e);
            // Fallback: envia apenas texto
            await this.sendKeepingUnread(
                () => this.client.sendText(chatId, text),
                chatId
            );
            try { messageStore.recordOutgoingMessage({ chatId: chatId, text: text, timestamp: Date.now() }); } catch (_) {}
        }
    }

    sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

    // ===== Injeção no WhatsApp Web para bloquear marcação de leitura =====
    async injectNoRead() {
        try {
            const page = this.client?.page || this.client?.pupPage;
            if (!page || typeof page.evaluate !== 'function') return;
            await page.evaluate(() => {
                try {
                    const noop = () => undefined;
                    const blockEventEmitter = (target) => {
                        if (!target) return;
                        ['emit','trigger','dispatchEvent','fire'].forEach((fn) => {
                            if (typeof target[fn] === 'function') target[fn] = () => {};
                        });
                    };
                    // Store overrides
                    if (window.Store) {
                        const stores = ['Msg', 'Message', 'MsgInfo', 'MessageInfo', 'WebMessageInfo', 'Chat', 'Conversation'];
                        stores.forEach((key) => {
                            const obj = window.Store[key];
                            if (obj) {
                                ['markAsRead', 'sendReadReceipt', 'sendSeen'].forEach((fn) => {
                                    if (obj[fn]) obj[fn] = noop;
                                });
                            }
                        });

                        // ReadReceipt sender
                        if (window.Store.ReadReceipt && typeof window.Store.ReadReceipt.send === 'function') {
                            window.Store.ReadReceipt.send = noop;
                        }
                        if (window.Store.ReadState) {
                            ['markAsRead', 'sendSeen', 'setComposing', 'setTyping'].forEach((fn) => {
                                if (typeof window.Store.ReadState[fn] === 'function') window.Store.ReadState[fn] = noop;
                            });
                        }
                        // Presence - TOTALMENTE DESABILITADO
                        if (window.Store.Presence) {
                            ['subscribe','subscribeAndWait','setPresenceAvailable','setMyPresence','sendPresenceAvailable','sendPresenceUnavailable']
                                .forEach((fn) => { if (typeof window.Store.Presence[fn] === 'function') window.Store.Presence[fn] = noop; });
                        }
                        if (window.Store.PresenceCollection) blockEventEmitter(window.Store.PresenceCollection);
                        
                        // BLOQUEIO TOTAL DE STATUS - Impede postagem e visualização de status
                        if (window.Store.Status) {
                            // Bloqueia TODAS as operações de status
                            ['send','upload','delete','view','get','getStatus','sendStatusMsg','sendStatusUpdate']
                                .forEach((fn) => { if (typeof window.Store.Status[fn] === 'function') window.Store.Status[fn] = noop; });
                        }
                        if (window.Store.StatusMessage) {
                            ['send','upload','delete']
                                .forEach((fn) => { if (typeof window.Store.StatusMessage[fn] === 'function') window.Store.StatusMessage[fn] = noop; });
                        }
                        // Bloqueia events de status
                        if (window.Store.StatusCollection) blockEventEmitter(window.Store.StatusCollection);
                        
                        // Bloqueia StoryManager se existir
                        if (window.Store.StoryManager) {
                            ['send','upload','delete','view','get','sync']
                                .forEach((fn) => { if (typeof window.Store.StoryManager[fn] === 'function') window.Store.StoryManager[fn] = noop; });
                        }

                        // Impede abertura/seleção de chats
                        if (window.Store.Chat) {
                            ['_open','open','select'].forEach((fn) => { if (typeof window.Store.Chat[fn] === 'function') window.Store.Chat[fn] = noop; });
                        }
                        if (window.Store.Cmd) {
                            ['openChatFromUnreadBar','openChatAt','profileSubscribe'].forEach((fn) => { if (typeof window.Store.Cmd[fn] === 'function') window.Store.Cmd[fn] = noop; });
                        }
                        if (window.Store.Conversation && typeof window.Store.Conversation.open === 'function') {
                            window.Store.Conversation.open = noop;
                        }
                    }

                    // WAPI helpers
                    if (window.WAPI) {
                        ['sendSeen', 'markAsRead', 'sendReadReceipt'].forEach((fn) => {
                            if (typeof window.WAPI[fn] === 'function') window.WAPI[fn] = noop;
                        });
                        if (typeof window.WAPI.sendPresenceAvailable === 'function') window.WAPI.sendPresenceAvailable = noop;
                        if (typeof window.WAPI.sendPresenceUnavailable === 'function') window.WAPI.sendPresenceUnavailable = noop;
                    }

                    // fetch interceptor
                    const origFetch = window.fetch;
                    window.fetch = (...args) => {
                        try {
                            const url = String(args?.[0] || '');
                            // Bloqueia leitura automática, status, presence, typing
                            if (/\b(read|readReceipts|sendSeen|markAsRead|presence|typing|composing|status|story|statusweb)\b/i.test(url)) {
                                return Promise.resolve(new Response(null, { status: 204 }));
                            }
                        } catch {}
                        return origFetch(...args);
                    };

                    // XHR interceptor - bloqueia leitura automática E status
                    const origOpen = XMLHttpRequest.prototype.open;
                    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                        try {
                            const s = String(url || '');
                            // Bloqueia leitura automática, status, presence, typing
                            if (/\b(read|readReceipts|sendSeen|markAsRead|presence|typing|composing|status|story|statusweb)\b/i.test(s)) {
                                this.send = () => undefined;
                                return;
                            }
                        } catch {}
                        return origOpen.call(this, method, url, ...rest);
                    };

                    // WebSocket interceptor - bloqueia leitura automática E status
                    if (window.WebSocket) {
                        const _send = window.WebSocket.prototype.send;
                        window.WebSocket.prototype.send = function(data) {
                            try {
                                const payload = typeof data === 'string' ? data : (data?.toString?.() || '');
                                // Bloqueia leitura automática, status, presence, typing
                                if (/\bread\b|\breadReceipts\b|\bmarkAsRead\b|\bsendSeen\b|\bpresence\b|\btyping\b|\bcomposing\b|\bstatus\b|\bstory\b|\bstatusweb\b/i.test(payload)) {
                                    return; // drop
                                }
                            } catch {}
                            return _send.apply(this, arguments);
                        };
                    }

                    // Evita handlers de visibilidade influenciarem
                    try {
                        document.addEventListener = new Proxy(document.addEventListener, {
                            apply(target, thisArg, argArray) {
                                if (argArray && /visibilitychange|focus|blur/i.test(String(argArray[0]))) {
                                    return; // não registrar
                                }
                                return Reflect.apply(target, thisArg, argArray);
                            }
                        });
                    } catch {}

                    // Neutraliza MutationObserver em áreas críticas
                    try {
                        const _MO = window.MutationObserver;
                        window.MutationObserver = function(cb) { return new _MO(() => {}); };
                    } catch {}
                } catch {}
            });
        } catch {}
    }

    /**
     * Envia uma mensagem de texto para um chat específico
     * @param {string} chatId - ID do chat (número do WhatsApp com @c.us)
     * @param {string} text - Texto da mensagem
     * @returns {Promise<object>} Resultado do envio
     */
    async sendMessage(chatId, text) {
        if (!this.client) {
            throw new Error('Bot não está conectado');
        }

        try {
            // Garante que o chatId está no formato correto
            if (!chatId.includes('@')) {
                chatId = chatId.includes('-') ? chatId : `${chatId}@c.us`;
            }

            // Envia mensagem usando sendKeepingUnread para não marcar como lida
            const result = await this.sendKeepingUnread(
                () => this.client.sendText(chatId, text),
                chatId
            );

            console.log(`📤 Mensagem enviada para ${chatId}: ${text.substring(0, 50)}...`);
            return result;
        } catch (error) {
            console.error('❌ Erro ao enviar mensagem:', error);
            throw error;
        }
    }

    /**
     * Envia um áudio para um chat específico
     * @param {string} chatId - ID do chat (número do WhatsApp com @c.us)
     * @param {string} audioPath - Caminho do arquivo de áudio
     * @param {string} fileName - Nome do arquivo
     * @returns {Promise<object>} Resultado do envio
     */
    async sendAudio(chatId, audioPath, fileName) {
        if (!this.client) {
            throw new Error('Bot não está conectado');
        }

        try {
            // Garante que o chatId está no formato correto
            if (!chatId.includes('@')) {
                chatId = chatId.includes('-') ? chatId : `${chatId}@c.us`;
            }

            // Tenta diferentes métodos de envio com o caminho do arquivo
            let result;
            try {
                // Tenta sendPtt primeiro (PTT = Push to Talk, formato recomendado)
                result = await this.client.sendPtt(chatId, audioPath);
            } catch (pttError) {
                try {
                    // Tenta sendFile como fallback
                    result = await this.client.sendFile(chatId, audioPath, fileName, '');
                } catch (fileError) {
                    throw new Error('Erro ao enviar áudio: ' + fileError.message);
                }
            }

            // Não marca como lida
            try {
                await this.client.markUnseenMessage(chatId);
            } catch {}

            return result;
        } catch (error) {
            console.error('❌ Erro ao enviar áudio:', error.message);
            throw error;
        }
    }


    /**
     * Encerra o bot e fecha a sessão com segurança.
     */
    async stop() {
        try {
            if (this._reinjectTicker) {
                clearInterval(this._reinjectTicker);
                this._reinjectTicker = null;
            }
            if (this.connectionTicker) {
                clearInterval(this.connectionTicker);
                this.connectionTicker = null;
            }
            if (this.client) {
                // Tenta fechar o navegador
                try {
                    const browser = this.client.pupBrowser;
                    if (browser && browser.isConnected()) {
                        await browser.close();
                        console.log('🛑 Navegador fechado.');
                    }
                } catch (e) {
                    console.log('⚠️ Erro ao fechar navegador:', e.message);
                }
                await this.client.close();
                console.log('🛑 Bot parado (wppconnect).');
            }
        } catch (e) {
            console.log('⚠️ Erro ao parar bot:', e.message);
        } finally {
            this.client = null;
            this.started = false;
        }
    }

    /**
     * Obtém a URL da foto de perfil no WhatsApp (pode exigir proxy pelo backend)
     */
    async getProfilePicUrl(chatId) {
        if (!this.client) throw new Error('Bot não está conectado');
        try {
            if (!chatId.includes('@')) {
                chatId = chatId.includes('-') ? chatId : `${chatId}@c.us`;
            }
            const url = await this.client.getProfilePicFromServer(chatId);
            return url || null;
        } catch (e) {
            return null;
        }
    }
    
    /**
     * Detecta se a mensagem é uma identificação de atendente humano
     */
    detectAttendantIdentification(text) {
        if (!text || text.length < 10) return false; // Texto muito curto
        
        // SIMPLES: Se tiver "atendente" na mensagem (de qualquer forma), é atendente humano
        return text.toLowerCase().includes('atendente');
    }
    
    /**
     * Verifica se mensagem já foi processada (evita duplicação)
     */
    isMessageProcessed(messageId) {
        if (!messageId) return false;
        return this.processedMessages.has(messageId);
    }
    
    /**
     * Verifica rate limiting para evitar spam de respostas
     */
    checkRateLimit(chatId) {
        if (!chatId) return false;
        
        const now = Date.now();
        const userRate = this.userResponseRate.get(chatId);
        
        // Primeira mensagem, permite
        if (!userRate) {
            this.userResponseRate.set(chatId, { lastResponse: now, count: 1 });
            return true;
        }
        
        // Reset contador após 1 minuto
        if (now - userRate.lastResponse > 60000) {
            this.userResponseRate.set(chatId, { lastResponse: now, count: 1 });
            return true;
        }
        
        // Máximo 5 respostas por minuto
        if (userRate.count >= 5) {
            return false;
        }
        
        // Incrementa contador
        this.userResponseRate.set(chatId, { lastResponse: now, count: userRate.count + 1 });
        return true;
    }
    
    /**
     * Limpa cache de mensagens antigas (mais de 10 minutos)
     * Limpa rate limiting antigo (mais de 5 minutos)
     */
    cleanupCache() {
        try {
            const now = Date.now();
            const maxAge = 10 * 60 * 1000; // 10 minutos
            
            // Limpa mensagens processadas antigas
            for (const [messageId, timestamp] of this.processedMessages.entries()) {
                if (now - timestamp > maxAge) {
                    this.processedMessages.delete(messageId);
                }
            }
            
            // Limpa rate limiting antigo (5 minutos)
            const rateMaxAge = 5 * 60 * 1000;
            for (const [chatId, rate] of this.userResponseRate.entries()) {
                if (now - rate.lastResponse > rateMaxAge) {
                    this.userResponseRate.delete(chatId);
                }
            }
            
            // Limpa estados de usuário antigos (30 minutos de inatividade)
            const userStateMaxAge = 30 * 60 * 1000;
            for (const [chatId, state] of this.userStates.entries()) {
                if (!state.lastActivity || now - state.lastActivity > userStateMaxAge) {
                    this.userStates.delete(chatId);
                }
            }
            
            console.log(`🧹 Cache limpo: ${this.processedMessages.size} msgs, ${this.userResponseRate.size} rates, ${this.userStates.size} estados`);
        } catch (e) {
            console.error('Erro ao limpar cache:', e);
        }
    }
}

module.exports = WhatsAppBot;


