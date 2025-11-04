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
        this.humanAttendingTime = new Map(); // guarda quando atendimento humano foi ativado (chatId -> timestamp)
        this.processedMessages = new Map(); // cache de mensagens processadas para evitar duplicação (messageId -> timestamp)
        this.userResponseRate = new Map(); // controle de rate limiting por usuário (chatId -> {lastResponse, count})
        this.inSupportSubmenu = new Map(); // guarda se chat está no submenu de suporte (chatId -> true/false)
        
        // Sistema de memória de contexto robusto
        this.conversationContext = new Map(); // guarda contexto completo da conversa por chatId
        // Estrutura: {
        //   currentMenu: 'main' | 'payment' | 'support' | 'support_sub' | 'other',
        //   currentStep: 'waiting_cpf' | 'waiting_pix' | 'waiting_option' | 'waiting_payment_option' | 'processing_cpf' | null,
        //   lastIntent: string,
        //   lastAction: string,
        //   conversationHistory: [], // últimas intenções/ações
        //   lastMessage: string,
        //   lastResponse: string,
        //   updatedAt: timestamp
        // }
        
        // Limpeza automática de cache a cada 10 minutos
        setInterval(() => this.cleanupCache(), 10 * 60 * 1000);
        
        // Reativação automática de atendimentos DESABILITADA - apenas reativação manual pelo painel
        // setInterval(() => this.cleanupAbandonedAttendances(), 1 * 60 * 1000);
        
        // Limpeza automática de contextos antigos após 30 minutos de inatividade
        setInterval(() => this.cleanupOldContexts(), 30 * 60 * 1000);
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
        
        // Carrega estado de pausa do banco de dados (persistência após reinício)
        this.loadPausedChatsFromDatabase();

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
     * Carrega estado de pausa do banco de dados na inicialização
     */
    loadPausedChatsFromDatabase() {
        try {
            const pausedChats = messageStore.getPausedChats();
            pausedChats.forEach(chatId => {
                this.humanAttending.set(chatId, true);
                // Recupera timestamp da última mensagem do atendente se disponível
                const chatData = messageStore.getChat(chatId);
                if (chatData && chatData.lastAttendantMessageAt) {
                    this.humanAttendingTime.set(chatId, chatData.lastAttendantMessageAt);
                } else {
                    // Se não tem timestamp, usa timestamp atual menos 10 minutos (para evitar timeout imediato)
                    this.humanAttendingTime.set(chatId, Date.now() - (10 * 60 * 1000));
                }
            });
            console.log(`✅ Carregados ${pausedChats.length} chats com bot pausado do banco de dados`);
        } catch (e) {
            console.error('❌ Erro ao carregar chats pausados do banco:', e);
        }
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
                console.log('📥 MENSAGEM RECEBIDA:', { 
                    id: message.id, 
                    from: message.from, 
                    body: message.body?.substring(0, 50),
                    isGroupMsg: message.isGroupMsg,
                    fromMe: message.fromMe
                });
                
                // Verificação de duplicação: ignora mensagem se já foi processada
                const messageId = message.id;
                if (this.isMessageProcessed(messageId)) {
                    console.log('⏭️ Mensagem já processada (duplicada), ignorando...');
                    return; // Mensagem já processada, ignora silenciosamente
                }
                
                // Marca mensagem como processada (guarda por 10 minutos)
                this.processedMessages.set(messageId, Date.now());
                
                console.log('✅ Mensagem passou pelas verificações iniciais, processando...');
                
                // Ignora grupos: bot atende só conversas privadas
                if (message.isGroupMsg === true || message.from?.includes('@g.us')) {
                    console.log('🤖 Mensagem de grupo ignorada (bot atende apenas conversas privadas).');
                    return;
                }
                
                // Ignora mensagens de status/stories (várias verificações para garantir)
                if (message.isStatus === true || 
                    message.from === 'status@broadcast' || 
                    message.from?.includes('status') || 
                    message.isStory === true || 
                    message.type === 'status' ||
                    message.type === 'ptt' && message.from?.includes('broadcast') ||
                    message.chatId?.includes('status@')) {
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
                        await this.pauseBotForChat(targetChatId, false); // Não envia mensagem, já está conversando
                        console.log(`👤 Atendente humano identificado para chat ${targetChatId}. Bot PAUSADO imediatamente para esta conversa.`);
                    }
                    
                    // Verifica se atendente quer reativar o bot (comando secreto)
                    if (bodyLower.includes('#reativar') || bodyLower.includes('#boton') || bodyLower.includes('#bot on')) {
                        await this.reactivateBotForChat(targetChatId, false); // Não envia mensagem, é comando secreto
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
                
                // Detecta se é PDF/documento recebido
                const isPdf = (message.mimetype && message.mimetype.includes('pdf')) || 
                             (message.type === 'document' && message.mimetype && message.mimetype.includes('pdf')) ||
                             (message.type === 'document' && message.fileName && message.fileName.toLowerCase().endsWith('.pdf'));
                
                if (isAudio && !message.fromMe) {
                    clientSentAudio = true; // Cliente enviou áudio
                    // Cliente enviou áudio - transcreve para texto e salva arquivo
                    console.log('🎤 Áudio recebido, transcrevendo...');
                    try {
                        const audioId = message.id || `audio_${Date.now()}`;
                        
                        // Faz download do áudio para salvar permanentemente
                        let audioSaved = false;
                        try {
                            const messageId = message.id || message._serialized || message.timestamp;
                            let media = await client.downloadMedia(messageId);
                            
                            if (!media && message.mediaData) {
                                media = message.mediaData;
                            }
                            
                            if (media) {
                                // Salva áudio permanentemente no diretório audios
                                const audioDir = path.join(__dirname, 'audios');
                                if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
                                
                                let audioData = media.data || media;
                                let mimetype = media.mimetype || message.mimetype || 'audio/ogg';
                                
                                // Remove prefixo data URL se existir
                                if (typeof audioData === 'string' && audioData.includes(',')) {
                                    audioData = audioData.split(',')[1];
                                }
                                
                                // Converte para OGG se necessário (para compatibilidade)
                                const audioPath = path.join(audioDir, `${audioId}.ogg`);
                                fs.writeFileSync(audioPath, Buffer.from(audioData, 'base64'));
                                audioSaved = true;
                                console.log(`✅ Áudio salvo: ${audioPath}`);
                            }
                        } catch (e) {
                            console.warn('⚠️ Erro ao salvar áudio:', e.message);
                        }
                        
                        // Transcreve áudio
                        const transcript = await audioTranscription.processWhatsAppAudio(message, client);
                        if (transcript && transcript.trim()) {
                            finalBody = transcript;
                            console.log(`✅ Áudio transcrito: "${transcript}"`);
                            
                            // Salva transcrição como mensagem de áudio no banco
                            try {
                                messageStore.recordIncomingMessage({ 
                                    chatId: message.from, 
                                    sender: message.from, 
                                    text: '[áudio]', 
                                    timestamp: Date.now(), 
                                    name: message.sender?.pushname || '',
                                    audioId: audioSaved ? audioId : null
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
                            
                            // Mesmo sem transcrição, salva mensagem de áudio se foi salvo
                            if (audioSaved) {
                                try {
                                    messageStore.recordIncomingMessage({ 
                                        chatId: message.from, 
                                        sender: message.from, 
                                        text: '[áudio]', 
                                        timestamp: Date.now(), 
                                        name: message.sender?.pushname || '',
                                        audioId 
                                    });
                                } catch (_) {}
                            }
                        }
                    } catch (e) {
                        console.error('❌ Erro ao processar áudio:', e);
                        finalBody = '[áudio]';
                        
                        // Tenta salvar mensagem de áudio mesmo com erro
                        try {
                            const audioId = message.id || `audio_${Date.now()}`;
                            messageStore.recordIncomingMessage({ 
                                chatId: message.from, 
                                sender: message.from, 
                                text: '[áudio]', 
                                timestamp: Date.now(), 
                                name: message.sender?.pushname || '',
                                audioId: null // Não salvo devido ao erro
                            });
                        } catch (_) {}
                    }
                }
                
                // Processa PDF recebido
                if (isPdf && !message.fromMe) {
                    console.log('📄 PDF recebido do cliente');
                    try {
                        // Tenta fazer download do PDF
                        const messageId = message.id || message._serialized || message.timestamp;
                        let media = null;
                        
                        try {
                            media = await client.downloadMedia(messageId);
                        } catch (e) {
                            console.warn('⚠️ Erro ao fazer download do PDF:', e.message);
                            // Tenta usar dados da mensagem se disponíveis
                            if (message.mediaData) {
                                media = message.mediaData;
                            }
                        }
                        
                        if (media) {
                            // Salva PDF no diretório files
                            const filesDir = path.join(__dirname, 'files');
                            if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
                            
                            let pdfData = media.data || media;
                            let mimetype = media.mimetype || message.mimetype || 'application/pdf';
                            
                            // Remove prefixo data URL se existir
                            if (typeof pdfData === 'string' && pdfData.includes(',')) {
                                pdfData = pdfData.split(',')[1];
                            }
                            
                            const fileId = `comprovante_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`;
                            const destPath = path.join(filesDir, fileId);
                            fs.writeFileSync(destPath, Buffer.from(pdfData, 'base64'));
                            
                            const fileName = message.fileName || message.name || 'comprovante.pdf';
                            
                            // Limpa o texto se contiver base64 ou dados de arquivo
                            let cleanText = finalBody || '';
                            if (cleanText) {
                                // Remove base64 se existir no texto
                                cleanText = cleanText.replace(/data:[^;]+;base64,[A-Za-z0-9+\/=]+/g, '');
                                cleanText = cleanText.replace(/[A-Za-z0-9+\/=]{100,}/g, ''); // Remove strings base64 longas
                                cleanText = cleanText.trim();
                            }
                            
                            // Se sobrou apenas base64 ou muito pouco texto, usa placeholder
                            if (!cleanText || cleanText.length < 3 || cleanText === '[arquivo]') {
                                cleanText = '[arquivo]';
                            }
                            
                            // Salva PDF no banco de dados
                            try {
                                messageStore.recordIncomingMessage({ 
                                    chatId: message.from, 
                                    sender: message.from, 
                                    text: cleanText, 
                                    timestamp: Date.now(), 
                                    name: message.sender?.pushname || '',
                                    fileId: fileId,
                                    fileName: fileName,
                                    fileType: mimetype
                                });
                            } catch (e) {
                                console.error('❌ Erro ao salvar PDF no banco:', e);
                            }
                            
                            // Se o cliente enviou apenas PDF sem texto legível, trata como comprovante
                            if (!cleanText || cleanText.trim() === '' || cleanText === '[arquivo]') {
                                console.log('📸 Cliente enviou apenas PDF (comprovante) - pausando bot');
                                // Pausa bot para atendimento humano processar comprovante
                                await this.pauseBotForChat(message.from, false); // Não envia mensagem, PDF é auto-explicativo
                                // Não responde nada - deixa atendente humano processar
                                return;
                            }
                        }
                    } catch (e) {
                        console.error('❌ Erro ao processar PDF:', e);
                    }
                }
                
                console.log(`📩 Mensagem recebida de ${message.from}: ${finalBody || '[sem texto]'}`);
                // Registrar no painel (incrementa não lidas) - só se não for áudio (já registrado acima) e não for PDF (já registrado acima)
                if ((!isAudio || finalBody === '[áudio]') && !isPdf) {
                    try { messageStore.recordIncomingMessage({ chatId: message.from, sender: message.from, text: finalBody, timestamp: Date.now(), name: message.sender?.pushname || '' }); } catch (_) {}
                }
                
                // DETECTA SE CLIENTE FALOU QUE VAI FALAR COM ATENDENTE OU JÁ FALOU COM ATENDENTE
                // Pausa bot IMEDIATAMENTE
                const finalBodyLower = finalBody.toLowerCase();
                const hasAttendantKeyword = finalBodyLower.includes('atendente') || finalBodyLower.includes('atendende');
                if (hasAttendantKeyword) {
                    // Cliente mencionou atendente - pausa bot para este chat
                    await this.pauseBotForChat(message.from, true); // Envia mensagem avisando cliente
                    console.log(`👤 Cliente mencionou atendente - bot pausado: "${finalBody.substring(0, 50)}..."`);
                    return; // Para IMEDIATAMENTE, não processa mais nada
                }
                
                // Filtro de mensagens de sistema (evita responder códigos/confirm.
                if (this.isSystemMessage(body)) {
                    console.log('⚠️ Mensagem de sistema ignorada.');
                return;
            }

                // Detecta CPF/documento (11+ dígitos) - APENAS SE HÁ TEXTO E NÃO É PDF
                // Se cliente enviou apenas PDF, já foi tratado acima e o bot foi pausado
                let doc = null;
                if (!isPdf && finalBody && finalBody.trim() && finalBody !== '[arquivo]') {
                    // Verifica se NÃO é URL, IP ou link antes de extrair documento
                    const textLower = finalBody.toLowerCase().trim();
                    const isUrl = textLower.startsWith('http://') || 
                                  textLower.startsWith('https://') || 
                                  textLower.startsWith('www.') ||
                                  textLower.includes('://') ||
                                  /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(textLower) || // IP address
                                  textLower.includes('.com') ||
                                  textLower.includes('.br') ||
                                  textLower.includes('.net') ||
                                  textLower.includes('.org');
                    
                    // Só tenta extrair CPF se NÃO for URL/link e se for texto curto (até 30 chars) ou apenas números
                    const isShortText = finalBody.trim().length <= 30;
                    const isOnlyNumbers = /^\d+$/.test(finalBody.trim());
                    
                    if (!isUrl && (isOnlyNumbers || isShortText)) {
                        doc = this.extractDocument(finalBody);
                    }
                }
                
                if (doc) {
                    const currentContext = this.getConversationContext(message.from);
                    
                    // Verifica se está no fluxo de pagamento aguardando CPF
                    if (currentContext.currentMenu === 'payment' && currentContext.currentStep === 'waiting_cpf') {
                        // Atualiza contexto: CPF recebido, processando
                        this.updateConversationContext(message.from, {
                            currentStep: 'processing_cpf',
                            lastAction: 'received_cpf'
                        });
                        
                        // Responde imediatamente que está processando
                        try {
                            await this.sendAudioResponse(message.from, 'Processando CPF, aguarde...', false);
                        } catch (_) {}
                        
                        try {
                            // Busca cliente e serviços com timeout
                            const cli = await Promise.race([
                                zcClientService.getClientByDocument(doc),
                                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
                            ]);
                            
                            if (!cli || !cli.id) {
                                throw new Error('Nenhum cliente encontrado');
                            }
                            
                            const services = await Promise.race([
                                zcClientService.getClientServices(cli.id),
                                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
                            ]);
                            
                            if (!services || services.length === 0) {
                                await this.sendAudioResponse(message.from, 'Cliente encontrado mas sem serviços ativos.', true);
                                return;
                            }
                            const activeService = services.find(s => s.status === 'ativo') || services[0];

                            // Busca contas e escolhe a mais recente
                            const bills = await Promise.race([
                                zcBillService.getBills(cli.id, activeService.id, 'INTERNET'),
                                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
                            ]);
                            
                            if (!bills || bills.length === 0) {
                                await this.sendAudioResponse(message.from, 'Nenhuma cobrança encontrada para este cliente.', true);
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
                                await this.sendAudioResponse(message.from, 'Não há nenhuma cobrança em atraso. Entre em contato conosco caso tenha dúvidas.', true);
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
                            this.userStates.set(message.from, {
                                clientId: cli.id,
                                serviceId: activeService.id,
                                billId: latest.id,
                                clientName: cli?.nome || 'cliente',
                                lastActivity: Date.now()
                            });

                            // PERGUNTA se quer PIX ou BOLETO
                            const paymentOptionMsg = `*CPF CONFIRMADO: ${cli?.nome || 'Cliente'}*

Como você deseja pagar?

*1️⃣ PIX*

*2️⃣ BOLETO*

⏱️ *Liberação em até 5 minutos após o pagamento*

Digite o *número* da opção`;
                            
                            // Atualiza contexto: aguardando escolha PIX ou boleto
                            this.updateConversationContext(message.from, {
                                currentStep: 'waiting_payment_option',
                                lastAction: 'cpf_confirmed',
                                lastResponse: paymentOptionMsg
                            });
                            
                            await this.sendKeepingUnread(() => client.sendText(message.from, paymentOptionMsg), message.from, paymentOptionMsg);
                            return;
                            
                        } catch (e) {
                            console.error('Erro ao buscar cliente por CPF:', e?.message || e);
                            let errorMessage = 'Não encontrei cliente com este CPF. Verifique e envie novamente.';
                            if (e?.message && (e.message.includes('timeout') || e.message.includes('Timeout'))) {
                                errorMessage = 'O servidor demorou para responder. Tente novamente em instantes ou envie menu para voltar ao início.';
                            } else if (e?.message && e.message.includes('Nenhum cliente encontrado')) {
                                errorMessage = 'CPF não encontrado. Verifique e envie novamente.';
                            }
                            // Garante que sempre responde, mesmo em caso de erro
                            try {
                                await this.sendAudioResponse(message.from, errorMessage, true);
                            } catch (sendError) {
                                console.error('Erro ao enviar mensagem de erro:', sendError);
                                // Tenta enviar como texto se áudio falhar
                                try {
                                    await this.sendKeepingUnread(() => client.sendText(message.from, errorMessage), message.from, errorMessage);
                                } catch (_) {}
                            }
                            return;
                        }
                    }
                    
                    // Se não está no fluxo de pagamento, processa como antes (compatibilidade)
                    // Busca e envia boleto direto (comportamento antigo)
                    // Responde imediatamente que está processando
                    try {
                        await this.sendAudioResponse(message.from, 'Processando CPF, aguarde...', false);
                    } catch (_) {}
                    
                    try {
                        const cli = await Promise.race([
                            zcClientService.getClientByDocument(doc),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
                        ]);
                        
                        if (!cli || !cli.id) {
                            throw new Error('Nenhum cliente encontrado');
                        }
                        
                        const services = await Promise.race([
                            zcClientService.getClientServices(cli.id),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
                        ]);
                        
                        if (!services || services.length === 0) {
                            await this.sendAudioResponse(message.from, 'Cliente encontrado mas sem serviços ativos.', true);
                            return;
                        }
                        const activeService = services.find(s => s.status === 'ativo') || services[0];
                        
                        const bills = await Promise.race([
                            zcBillService.getBills(cli.id, activeService.id, 'INTERNET'),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
                        ]);
                        
                        if (!bills || bills.length === 0) {
                            await this.sendAudioResponse(message.from, 'Nenhuma cobrança encontrada para este cliente.', true);
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
                            await this.sendAudioResponse(message.from, 'Não há nenhuma cobrança em atraso. Entre em contato conosco caso tenha dúvidas.', true);
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
                        
                        this.userStates.set(message.from, {
                            clientId: cli.id,
                            serviceId: activeService.id,
                            billId: latest.id,
                            clientName: cli?.nome || 'cliente',
                            lastActivity: Date.now()
                        });

                        const pdfPath = await zcBillService.generateBillPDF(cli.id, activeService.id, latest.id);
                        const caption = `*📄 BOLETO DE ${cli?.nome || 'cliente'}*\n\n*Se preferir pagar com PIX responda pix*`;
                        
                        this.updateConversationContext(message.from, {
                            currentStep: 'waiting_pix',
                            lastAction: 'sent_bill',
                            lastResponse: caption
                        });
                        
                        await this.sendAudioResponse(message.from, `Boleto de ${cli?.nome || 'cliente'}. Se preferir pagar com PIX responda pix.`, true);
                        await this.sendKeepingUnread(() => client.sendFile(message.from, pdfPath, 'boleto.pdf', caption), message.from);
                        
                        // Envia mensagem para voltar ao menu após enviar boleto
                        const backToMenuMsg = `\n\n📱 *Digite 8 para voltar ao menu*`;
                        await this.sendKeepingUnread(() => client.sendText(message.from, backToMenuMsg), message.from, backToMenuMsg);

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
                                text: caption,
                                timestamp: Date.now(),
                                fileId,
                                fileName: 'boleto.pdf',
                                fileType: 'application/pdf'
                            });
                        } catch (_) {
                            try { messageStore.recordOutgoingMessage({ chatId: message.from, text: '[arquivo] boleto.pdf - ' + caption, timestamp: Date.now() }); } catch (_) {}
                        }
                        
                        await this.pauseBotForChat(message.from, false); // Não envia mensagem, já enviou boleto
                        console.log(`⏸️ Bot pausado para chat ${message.from} após enviar boleto.`);
                        return;
                    } catch (e) {
                        console.error('Erro ao buscar boleto por documento:', e?.message || e);
                        
                        // Tratamento de erros específicos
                        let errorMessage = 'Não encontrei boleto. Confira o CPF somente números ou envie menu.';
                        if (e?.message && (e.message.includes('timeout') || e.message.includes('Timeout'))) {
                            errorMessage = 'O servidor demorou para responder. Tente novamente em instantes ou envie menu para voltar ao início.';
                        } else if (e?.message && e.message.includes('Nenhum cliente encontrado')) {
                            errorMessage = 'CPF não encontrado. Verifique e envie novamente.';
                        }
                        
                        // Garante que sempre responde, mesmo em caso de erro
                        try {
                            await this.sendAudioResponse(message.from, errorMessage, true);
                        } catch (sendError) {
                            console.error('Erro ao enviar mensagem de erro:', sendError);
                            // Tenta enviar como texto se áudio falhar
                            try {
                                await this.sendKeepingUnread(() => client.sendText(message.from, errorMessage), message.from, errorMessage);
                            } catch (_) {}
                        }
                        return;
                    }
                }

                // Comandos simples e palavras-chave (usa texto transcrito se for áudio)
                const text = finalBody.trim();
                
            // PRIORIDADE ABSOLUTA: Verifica se cliente quer voltar ao menu (comando "menu" ou "#menu" ou "8")
            // Isso DEVE ser verificado ANTES DE QUALQUER OUTRA COISA para funcionar sempre, independente do estado
            const textCheck = text.trim().toLowerCase();
            const isMenuCommand = textCheck === 'menu' || textCheck === '#menu' || textCheck.includes('menu');
            // "8" funciona SEMPRE que o usuário digitar, independente do estado atual - ABSOLUTA PRIORIDADE
            const isBackToMenu = textCheck === '8';
            
            if (isMenuCommand || isBackToMenu) {
                console.log(`📋 Cliente solicitou menu (${isBackToMenu ? 'digite 8' : 'menu'}) - reativando bot e mostrando menu principal`);
                
                // Reativa o bot se estiver pausado
                if (this.humanAttending.get(message.from) === true) {
                    await this.reactivateBotForChat(message.from, false); // Não envia mensagem, já vai mostrar menu
                    console.log(`🤖 Bot reativado pelo comando menu`);
                }
                
                // LIMPA COMPLETAMENTE o estado do usuário para garantir que não há conflitos
                this.inSupportSubmenu.delete(message.from);
                this.userStates.delete(message.from); // Remove dados antigos de pagamento/CPF
                
                const menuMsg = `*COMO POSSO AJUDAR?*

*1️⃣ PAGAMENTO / SEGUNDA VIA*

*2️⃣ SUPORTE TÉCNICO*

*3️⃣ FALAR COM ATENDENTE*

*4️⃣ OUTRAS DÚVIDAS*

Digite o *número* da opção`;
                
                // Atualiza contexto: menu principal - LIMPA completamente
                this.updateConversationContext(message.from, {
                    currentMenu: 'main',
                    currentStep: null,
                    lastAction: 'send_menu',
                    lastResponse: menuMsg,
                    lastMessage: null,
                    lastIntent: null
                });
                
                await this.sendKeepingUnread(() => client.sendText(message.from, menuMsg), message.from, menuMsg);
                return;
            }
            
            // Obtém contexto atual da conversa
            const conversationContext = this.getConversationContext(message.from);
            
            // Analisa intenção da mensagem com contexto de múltiplas mensagens
            let contextResult;
            try {
                contextResult = await contextAnalyzer.analyzeContext(message.from, text);
                console.log(`🧠 Análise de contexto: intent=${contextResult.intent}, confidence=${contextResult.confidence.toFixed(2)}, mensagens=${contextResult.messagesCount}, menu=${conversationContext.currentMenu}, step=${conversationContext.currentStep}`);
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
            
            // Verifica se a intenção faz sentido no contexto atual
            const isValidContext = this.isContextValid(intent, message.from, text);
            if (!isValidContext) {
                console.log(`⚠️ Mensagem fora de contexto detectada - intent=${intent}, menu=${conversationContext.currentMenu}, step=${conversationContext.currentStep}`);
                // Atualiza contexto e permite se intenção é clara
                this.updateConversationContext(message.from, {
                    lastMessage: text,
                    lastIntent: intent
                });
                // Continua o processamento mesmo se fora de contexto (pode ser cliente mudando de assunto)
            }
            
            // Atualiza contexto com a mensagem atual
            this.updateConversationContext(message.from, {
                lastMessage: text,
                lastIntent: intent
            });
            
            // Verifica opções do menu principal (1, 2, 3, 4) - PRIORIDADE MÁXIMA após voltar ao menu
            // IMPORTANTE: Estas verificações devem vir ANTES de todas as outras para garantir funcionamento correto
            // Atualiza contexto para garantir que está atualizado após voltar ao menu
            const currentContext = this.getConversationContext(message.from);
            // Verifica se está no menu principal - considera null/undefined também como menu principal
            const isMainMenu = currentContext.currentMenu === 'main' || 
                               currentContext.currentMenu === null || 
                               currentContext.currentMenu === undefined;
            
            if (textLower.trim() === '1' && isMainMenu) {
                console.log(`💳 Cliente selecionou opção 1 - Pagamento`);
                // Garante que userStates está limpo
                this.userStates.delete(message.from);
                const response = `*PAGAMENTO / SEGUNDA VIA*

Para gerar seu boleto ou PIX, envie seu *CPF* (somente números)

*# VOLTAR* ou *# FINALIZAR ATENDIMENTO*`;
                // Atualiza contexto: menu de pagamento, aguardando CPF
                this.updateConversationContext(message.from, {
                    currentMenu: 'payment',
                    currentStep: 'waiting_cpf',
                    lastAction: 'show_payment_menu',
                    lastResponse: response
                });
                await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                return;
            }
            
            if (textLower.trim() === '2' && isMainMenu) {
                console.log(`🔧 Cliente selecionou opção 2 - Suporte técnico`);
                // Garante que está limpo antes de entrar no submenu
                this.userStates.delete(message.from);
                // Define que está no submenu de suporte
                this.inSupportSubmenu.set(message.from, true);
                const response = `*SUPORTE TÉCNICO*

*1️⃣ INTERNET LENTA*

*2️⃣ SEM CONEXÃO*

*3️⃣ JÁ PAGUEI*

*9️⃣ FINALIZAR ATENDIMENTO*

*# VOLTAR* ou *# FINALIZAR ATENDIMENTO*

Digite o *número* da opção

📱 *Digite 8 para voltar ao menu*`;
                // Atualiza contexto: submenu de suporte - GARANTE que está atualizado
                this.updateConversationContext(message.from, {
                    currentMenu: 'support_sub',
                    currentStep: 'waiting_option',
                    lastAction: 'show_support_submenu',
                    lastResponse: response,
                    lastMessage: null,
                    lastIntent: null
                });
                await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                return;
            }
            
            if (textLower.trim() === '3' && isMainMenu) {
                console.log(`👤 Cliente selecionou opção 3 - Atendimento humano`);
                // Atualiza contexto: atendimento humano ativo
                this.updateConversationContext(message.from, {
                    currentMenu: 'main',
                    currentStep: null,
                    lastAction: 'human_attending_requested',
                    lastResponse: null
                });
                const response = `*Estamos preparando seu atendimento, logo um atendente irá te atender.*`;
                await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                // Pausa o bot para este chat - atendimento humano ativo (não envia mensagem adicional, já enviou acima)
                await this.pauseBotForChat(message.from, false);
                console.log(`⏸️ Bot pausado para chat ${message.from} - aguardando atendimento humano. Reativação apenas manual pelo painel.`);
                return;
            }
            
            if (textLower.trim() === '4' && isMainMenu) {
                console.log(`❓ Cliente selecionou opção 4 - Outras dúvidas`);
                const response = `*OUTRAS DÚVIDAS*

Digite sua dúvida que vamos te orientar.

*# VOLTAR* ou *# FINALIZAR ATENDIMENTO*`;
                // Atualiza contexto: menu outras dúvidas
                this.updateConversationContext(message.from, {
                    currentMenu: 'other',
                    currentStep: null,
                    lastAction: 'show_other_menu',
                    lastResponse: response
                });
                await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                return;
            }
            
            // Verifica opções do submenu de suporte (1, 2, 3) - PRIORIDADE após menu principal
            // IMPORTANTE: Estas verificações devem vir ANTES de outras verificações para garantir funcionamento correto
            // Atualiza contexto para garantir que está atualizado
            const supportContext = this.getConversationContext(message.from);
            const isInSupportSubmenu = this.inSupportSubmenu.get(message.from) === true || 
                                       supportContext.currentMenu === 'support_sub';
            
            if (isInSupportSubmenu) {
                // Opção 1 - Internet Lenta
                if (textLower.trim() === '1' || text.includes('internet lenta')) {
                    console.log(`🔧 Cliente selecionou opção 1 - Internet lenta`);
                    this.inSupportSubmenu.delete(message.from); // Remove do submenu
                    const response = `*INTERNET LENTA*

*SOLUÇÃO:*

*• DESLIGUE O ROTEADOR.*
*• AGUARDE 30 SEGUNDOS.*
*• LIGUE NOVAMENTE.*
*• AGUARDE 5 MINUTOS.*

📞 *Não resolveu?* Digite *"3"*

📱 *Digite 8 para voltar ao menu*`;
                    // Atualiza contexto: saiu do submenu
                    this.updateConversationContext(message.from, {
                        currentMenu: 'main',
                        currentStep: null,
                        lastAction: 'internet_lenta_shown',
                        lastResponse: response
                    });
                    await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                    return;
                }
                
                // Opção 2 - Sem Conexão
                if (textLower.trim() === '2' || text.includes('internet caiu') || text.includes('caiu internet') || text.includes('sem conexão') || text.includes('sem conexao')) {
                    console.log(`🔧 Cliente selecionou opção 2 - Sem conexão`);
                    this.inSupportSubmenu.delete(message.from); // Remove do submenu
                    const response = `*SEM CONEXÃO*

*SOLUÇÃO:*

*• VERIFIQUE CABOS CONECTADOS.*
*• VERIFIQUE SE ROTEADOR ESTÁ LIGADO.*
*• DESLIGUE E LIGUE NOVAMENTE.*

📞 *Não resolveu?* Digite *"3"*

📱 *Digite 8 para voltar ao menu*`;
                    // Atualiza contexto: saiu do submenu
                    this.updateConversationContext(message.from, {
                        currentMenu: 'main',
                        currentStep: null,
                        lastAction: 'sem_conexao_shown',
                        lastResponse: response
                    });
                    await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                    return;
                }
                
                // Opção 3 - Já Paguei
                if (textLower.trim() === '3' || text.includes('já paguei') || text.includes('ja paguei')) {
                    console.log(`🔧 Cliente selecionou opção 3 - Já pagou`);
                    this.inSupportSubmenu.delete(message.from); // Remove do submenu
                    const response = `*JÁ PAGUEI*

⏱️ *Liberação em até 10 minutos.*

📞 *Não liberou?* Digite *"3"*

📱 *Digite 8 para voltar ao menu*`;
                    // Atualiza contexto: saiu do submenu
                    this.updateConversationContext(message.from, {
                        currentMenu: 'main',
                        currentStep: null,
                        lastAction: 'ja_paguei_shown',
                        lastResponse: response
                    });
                    await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                    return;
                }
            }
            
            // Rate limiting: evita spam de respostas - APENAS para mensagens que não são comandos/opções de menu
            // Comandos importantes e opções de menu já foram processados acima, então não bloqueia
            const isMenuCommandCheck = textCheck === 'menu' || textCheck === '#menu' || textCheck.includes('menu') || textCheck === '8';
            const isMenuOptionCheck = (textLower.trim() === '1' || textLower.trim() === '2' || textLower.trim() === '3' || textLower.trim() === '4' || 
                                      textLower.trim() === '9' || textLower.trim() === '#' || textLower.trim() === '#voltar' || textLower.trim() === '#0' ||
                                      textLower.trim() === '#finalizar' || textLower.trim() === '#9');
            
            // Só aplica rate limit se NÃO for comando de menu ou opção de menu
            if (!isMenuCommandCheck && !isMenuOptionCheck) {
                if (!this.checkRateLimit(message.from)) {
                    console.log('⏸️ Rate limit atingido, ignorando...');
                    return; // Rate limit atingido, ignora silenciosamente
                }
            }
            
            // VERIFICAÇÃO CRÍTICA: Verifica se atendente enviou mensagem recente antes de responder
            // Isso evita que bot responda enquanto atendente está conversando
            const lastAttendantMsg = messageStore.getLastAttendantMessage(message.from);
            const now = Date.now();
            const timeSinceLastAttendantMsg = lastAttendantMsg ? (now - lastAttendantMsg) : Infinity;
            
            // Se atendente enviou mensagem nos últimos 10 segundos, não responde
            if (lastAttendantMsg && timeSinceLastAttendantMsg < 10000) {
                console.log(`⏸️ Atendente enviou mensagem há ${Math.floor(timeSinceLastAttendantMsg / 1000)}s - bot não responde para evitar conflito`);
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
                return; // Não responde - atendente acabou de enviar mensagem
            }
            
            // VERIFICAÇÃO: Se atendimento humano está ativo, verifica se cliente quer reativar
            // EXCEÇÃO: solicitações de pagamento SEMPRE reativam o bot
            const isPaymentRequest = intent === 'request_payment';
            const isPaymentCommand = textCheck.includes('pix') || textCheck === '9' || textCheck.match(/^\d{11,14}$/);
            
            if (this.humanAttending.get(message.from) === true) {
                if (isPaymentCommand || isPaymentRequest) {
                    // Cliente quer pagar ou reativar bot
                    if (textCheck === '9') {
                        console.log(`🤖 Cliente digitou "9" - reativando bot.`);
                    } else {
                        console.log(`🤖 Cliente solicitou pagamento - reativando bot para atendimento automático.`);
                    }
                    await this.reactivateBotForChat(message.from, false); // Não envia mensagem, já vai processar pagamento
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
            
            // DELAY MÍNIMO antes de responder (evita responder enquanto atendente está digitando)
            // Aguarda 2-3 segundos antes de processar e responder
            await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));
            
            // Verifica novamente se atendente enviou mensagem durante o delay
            const lastAttendantMsgAfterDelay = messageStore.getLastAttendantMessage(message.from);
            if (lastAttendantMsgAfterDelay && lastAttendantMsgAfterDelay !== lastAttendantMsg) {
                console.log(`⏸️ Atendente enviou mensagem durante delay - bot não responde`);
                return; // Atendente enviou mensagem durante delay, não responde
            }
            
            // Verifica novamente se bot foi pausado durante o delay
            if (this.humanAttending.get(message.from) === true) {
                console.log(`⏸️ Bot foi pausado durante delay - não responde`);
                return;
            }
            
            // 1. Confirmação de pagamento feito - NÃO responde nada, apenas pausa
            if (intent === 'confirm_payment') {
                // Quando cliente confirma pagamento, bot NÃO responde - apenas pausa para atendente humano
                console.log(`💬 Cliente confirmou pagamento - bot pausado sem resposta: "${text.substring(0, 50)}..."`);
                await this.pauseBotForChat(message.from, false); // Não envia mensagem, atendente vai processar
                return; // Não responde nada
            }
            
            // 1.1 Suporte técnico - Internet lenta
            if (intent === 'support_slow') {
                console.log(`🔧 Cliente reportou internet lenta: "${text.substring(0, 50)}..."`);
                const response = `*INTERNET LENTA*

*SOLUÇÃO:*

*• DESLIGUE O ROTEADOR.*
*• AGUARDE 30 SEGUNDOS.*
*• LIGUE NOVAMENTE.*
*• AGUARDE 5 MINUTOS.*

📞 *Não resolveu?* Digite *"3"*

📱 *Digite 8 para voltar ao menu*`;
                await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                return;
            }
            
            // 1.2 Suporte técnico - Sem conexão
            if (intent === 'support_dropped') {
                console.log(`📶 Cliente reportou sem conexão: "${text.substring(0, 50)}..."`);
                const response = `*SEM CONEXÃO*

*SOLUÇÃO:*

*• VERIFIQUE CABOS CONECTADOS.*
*• VERIFIQUE SE ROTEADOR ESTÁ LIGADO.*
*• DESLIGUE E LIGUE NOVAMENTE.*

📞 *Não voltou?* Digite *"3"*

📱 *Digite 8 para voltar ao menu*`;
                await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                return;
            }
            
            // 1.3 Suporte técnico - Problemas gerais
            if (intent === 'support_technical') {
                console.log(`🔧 Cliente reportou problema técnico: "${text.substring(0, 50)}..."`);
                const response = `*PROBLEMA TÉCNICO*

*VERIFICAR:*

✅ *Equipamentos ligados*
✅ *Cabos conectados*
✅ *Reiniciar roteador*

📞 *Precisa de ajuda?* Digite *"3"*

📱 *Digite 8 para voltar ao menu*`;
                await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                return;
            }
            
            // 1.4 Suporte - Já pagou mas não liberou
            if (intent === 'support_paid_not_working') {
                console.log(`💳 Cliente já pagou mas internet não liberou: "${text.substring(0, 50)}..."`);
                const response = `*PAGAMENTO PROCESSANDO*

⏱️ *Aguarde até 10 minutos*

*DEPOIS:*

*1.* Aguarde 10 minutos
*2.* Desligue/ligue roteador
*3.* Internet será liberada

📸 *Passou 10 min?* Envie comprovante.

📱 *Digite 8 para voltar ao menu*`;
                await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                return;
            }
            
            // 2. Cliente informando que vai pagar presencialmente (ignorar E pausar bot)
            // VERIFICA ANTES de checar se bot está pausado - prioridade máxima
            if (intent === 'inform_presential') {
                console.log(`💬 Cliente informando pagamento presencial - mensagem ignorada e bot pausado: "${text}"`);
                // Pausa o bot para este chat - cliente vai pagar pessoalmente, não precisa de mais nada
                await this.pauseBotForChat(message.from, false); // Não envia mensagem, cliente já informou
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
            
            // Verifica se está aguardando escolha entre PIX e boleto ANTES de qualquer outro processamento
            // (Isso deve ser verificado ANTES do bloco unclear para funcionar independente da intenção)
            if (conversationContext.currentMenu === 'payment' && conversationContext.currentStep === 'waiting_payment_option') {
                const ctx = this.userStates.get(message.from);
                
                // Cliente escolheu PIX (opção 1 ou palavra "pix")
                if (textLower.trim() === '1' || textLower.includes('pix') || textLower.trim() === 'pix') {
                    if (!ctx) {
                        const response = `*❌ ERRO*\n\nDados não encontrados. Por favor, envie seu CPF novamente.`;
                        await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                        this.updateConversationContext(message.from, {
                            currentStep: 'waiting_cpf',
                            lastAction: 'error_no_context'
                        });
                        return;
                    }
                    
                    // Gera e envia PIX diretamente
                    try {
                        const pix = await zcBillService.generatePixQRCode(ctx.clientId, ctx.serviceId, ctx.billId);
                        const parsed = this.parsePixPayload(pix);
                        
                        if (parsed.imageBase64) {
                            await this.sendAudioResponse(message.from, 'QR code PIX. Escaneie para pagar via PIX.', true);
                            await this.sendKeepingUnread(() => client.sendImageFromBase64(message.from, parsed.imageBase64, 'pix.png', '*🔵 QRCODE PIX*\n\n*ESCANEIE PARA PAGAR VIA PIX*'), message.from);
                            
                            try {
                                const path = require('path');
                                const fs = require('fs');
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
                                    chatId: message.from,
                                    text: '🔵 QRCode PIX',
                                    timestamp: Date.now(),
                                    fileId,
                                    fileName: 'qrcode-pix.png',
                                    fileType: 'image/png'
                                });
                            } catch (_) {
                                try { messageStore.recordOutgoingMessage({ chatId: message.from, text: '[imagem] QRCode PIX', timestamp: Date.now() }); } catch (_) {}
                            }
                        }
                        
                        if (parsed.payload) {
                            await this.sendAudioResponse(message.from, 'Copia o código abaixo e cole no seu banco para efetuar o pagamento', true);
                            await new Promise(resolve => setTimeout(resolve, 500));
                            await this.sendKeepingUnread(() => client.sendText(message.from, parsed.payload), message.from, parsed.payload);
                            try { messageStore.recordOutgoingMessage({ chatId: message.from, text: parsed.payload }); } catch (_) {}
                            
                            // Envia imagem com instruções de como copiar o código PIX corretamente
                            await new Promise(resolve => setTimeout(resolve, 500));
                            await this.sendPixInstructionsImage(message.from);
                        }
                        
                        if (!parsed.imageBase64 && !parsed.payload) {
                            await this.sendAudioResponse(message.from, 'Erro! PIX gerado, mas não recebi imagem nem código utilizável da API.', true);
                            return;
                        }
                        
                        // Envia mensagem pós-PIX
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        const postPixMsg = `*PIX ENVIADO!*

⏱️ *Liberação em até 5 minutos*

*Se após 5 minutos não houve liberação automática:*

*• Desligue e ligue o roteador*
*• Aguarde a reconexão*

📞 *Não voltou?* Digite *"3"*

📱 *Digite 8 para voltar ao menu*`;
                        
                        this.updateConversationContext(message.from, {
                            currentStep: 'waiting_payment_confirmation',
                            lastAction: 'sent_pix',
                            lastResponse: postPixMsg
                        });
                        
                        await this.sendKeepingUnread(() => client.sendText(message.from, postPixMsg), message.from, postPixMsg);
                        await this.pauseBotForChat(message.from, false); // Não envia mensagem, já enviou PIX
                        console.log(`⏸️ Bot pausado para chat ${message.from} após enviar PIX.`);
                        return;
                        
                    } catch (e) {
                        console.error('Erro ao gerar PIX:', e);
                        await this.sendAudioResponse(message.from, 'Erro ao gerar PIX. Tente novamente.', true);
                        return;
                    }
                }
                
                // Cliente escolheu BOLETO (opção 2)
                if (textLower.trim() === '2' || textLower.includes('boleto') || textLower.trim() === 'boleto') {
                    if (!ctx) {
                        const response = `*❌ ERRO*\n\nDados não encontrados. Por favor, envie seu CPF novamente.`;
                        await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                        this.updateConversationContext(message.from, {
                            currentStep: 'waiting_cpf',
                            lastAction: 'error_no_context'
                        });
                        return;
                    }
                    
                    // Gera e envia boleto
                    try {
                        const pdfPath = await zcBillService.generateBillPDF(ctx.clientId, ctx.serviceId, ctx.billId);
                        const caption = `*📄 BOLETO DE ${ctx.clientName || 'cliente'}*\n\n⏱️ *Liberação em até 5 minutos após o pagamento*`;
                        
                        this.updateConversationContext(message.from, {
                            currentStep: 'waiting_payment_confirmation',
                            lastAction: 'sent_bill',
                            lastResponse: caption
                        });
                        
                        await this.sendAudioResponse(message.from, `Boleto de ${ctx.clientName || 'cliente'}. Liberação em até 5 minutos após o pagamento.`, true);
                        await this.sendKeepingUnread(() => client.sendFile(message.from, pdfPath, 'boleto.pdf', caption), message.from);
                        
                        // Envia mensagem para voltar ao menu após enviar boleto
                        const backToMenuMsg = `\n\n📱 *Digite 8 para voltar ao menu*`;
                        await this.sendKeepingUnread(() => client.sendText(message.from, backToMenuMsg), message.from, backToMenuMsg);

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
                                text: caption,
                                timestamp: Date.now(),
                                fileId,
                                fileName: 'boleto.pdf',
                                fileType: 'application/pdf'
                            });
                        } catch (_) {
                            try { messageStore.recordOutgoingMessage({ chatId: message.from, text: '[arquivo] boleto.pdf - ' + caption, timestamp: Date.now() }); } catch (_) {}
                        }
                        
                        await this.pauseBotForChat(message.from, false); // Não envia mensagem, já enviou boleto
                        console.log(`⏸️ Bot pausado para chat ${message.from} após enviar boleto.`);
                        return;
                        
                    } catch (e) {
                        console.error('Erro ao gerar boleto:', e);
                        await this.sendAudioResponse(message.from, 'Erro ao gerar boleto. Tente novamente.', true);
                        return;
                    }
                }
                
                // Se não é nem PIX nem boleto, pede escolha novamente
                const response = `*Por favor, escolha uma opção:*

*1️⃣ PIX*

*2️⃣ BOLETO*

Digite o *número* da opção`;
                await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                return;
            }
            
            // 3. Se intenção não clara (unclear), verifica se é problema relacionado a pagamento
            // Se tiver palavras de pagamento E problema, pausa bot para atendimento humano
            if (intent === 'unclear') {
                // Verifica se está no submenu de suporte e digitou 1, 2 ou 3 (fallback caso não tenha sido capturado antes)
                if (this.inSupportSubmenu.get(message.from) === true || conversationContext.currentMenu === 'support_sub') {
                    if (textLower.trim() === '1' || text.includes('internet lenta')) {
                        console.log(`🔧 Cliente reportou internet lenta (fallback)`);
                        this.inSupportSubmenu.delete(message.from);
                        const response = `*INTERNET LENTA*

*SOLUÇÃO:*

*• DESLIGUE O ROTEADOR.*
*• AGUARDE 30 SEGUNDOS.*
*• LIGUE NOVAMENTE.*
*• AGUARDE 5 MINUTOS.*

📞 *Não resolveu?* Digite *"3"*

📱 *Digite 8 para voltar ao menu*`;
                        // Atualiza contexto: saiu do submenu
                        this.updateConversationContext(message.from, {
                            currentMenu: 'main',
                            currentStep: null,
                            lastAction: 'internet_lenta_shown',
                            lastResponse: response
                        });
                        await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                        return;
                    }
                    
                    if (textLower.trim() === '2' || text.includes('internet caiu') || text.includes('caiu internet') || text.includes('sem conexão') || text.includes('sem conexao')) {
                        console.log(`🔧 Cliente reportou sem conexão (fallback)`);
                        this.inSupportSubmenu.delete(message.from);
                        const response = `*SEM CONEXÃO*

*SOLUÇÃO:*

*• VERIFIQUE CABOS CONECTADOS.*
*• VERIFIQUE SE ROTEADOR ESTÁ LIGADO.*
*• DESLIGUE E LIGUE NOVAMENTE.*

📞 *Não resolveu?* Digite *"3"*

📱 *Digite 8 para voltar ao menu*`;
                        // Atualiza contexto: saiu do submenu
                        this.updateConversationContext(message.from, {
                            currentMenu: 'main',
                            currentStep: null,
                            lastAction: 'sem_conexao_shown',
                            lastResponse: response
                        });
                        await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                        return;
                    }
                    
                    if (textLower.trim() === '3' || text.includes('já paguei') || text.includes('ja paguei')) {
                        console.log(`🔧 Cliente reportou já pagou (fallback)`);
                        this.inSupportSubmenu.delete(message.from);
                        const response = `*JÁ PAGUEI*

⏱️ *Liberação em até 10 minutos.*

📞 *Não liberou?* Digite *"3"*

📱 *Digite 8 para voltar ao menu*`;
                        // Atualiza contexto: saiu do submenu
                        this.updateConversationContext(message.from, {
                            currentMenu: 'main',
                            currentStep: null,
                            lastAction: 'ja_paguei_shown',
                            lastResponse: response
                        });
                        await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                        return;
                    }
                }
                
                // Verifica se é saudação inicial (oi, olá, bom dia, etc) - com mais variações
                const greetings = [
                    'oi', 'olá', 'ola', 'oi!', 'ola!', 'olá!',
                    'bom dia', 'bomdia', 'bom-dia', 'bom dia!', 'bodia',
                    'boa tarde', 'boatarde', 'boa-tarde', 'boa tarde!', 'boatarde',
                    'boa noite', 'boanoite', 'boa-noite', 'boa noite!', 'boanoite',
                    'e aí', 'eai', 'eaí', 'e aí?', 'e ai',
                    'opá', 'opa', 'olá tudo bem', 'oi tudo bem', 'ola tudo bem',
                    'bom dia tudo bem', 'boa tarde tudo bem', 'boa noite tudo bem',
                    'hey', 'hi', 'hello', 'hola'
                ];
                
                // Verifica se é saudação: match exato ou contém a saudação (permitindo outras palavras depois)
                const isGreeting = greetings.some(g => {
                    const greetingLower = g.toLowerCase();
                    // Match exato
                    if (textLower.trim() === greetingLower) return true;
                    // Começa com a saudação
                    if (textLower.trim().startsWith(greetingLower + ' ') || 
                        textLower.trim().startsWith(greetingLower + ',') ||
                        textLower.trim().startsWith(greetingLower + '!')) return true;
                    // Contém a saudação como palavra completa (não parte de outra palavra)
                    const regex = new RegExp(`\\b${greetingLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                    if (regex.test(textLower) && textLower.length < 100) return true; // Limita para evitar falsos positivos
                    return false;
                });
                
                if (isGreeting) {
                    console.log(`👋 Cliente saudou (${textLower.substring(0, 30)}) - enviando menu de opções`);
                    const menuMsg = `*COMO POSSO AJUDAR?*

*1️⃣ PAGAMENTO / SEGUNDA VIA*

*2️⃣ SUPORTE TÉCNICO*

*3️⃣ FALAR COM ATENDENTE*

*4️⃣ OUTRAS DÚVIDAS*

Digite o *número* da opção`;
                    // Atualiza contexto: menu principal
                    this.updateConversationContext(message.from, {
                        currentMenu: 'main',
                        currentStep: null,
                        lastAction: 'send_menu',
                        lastResponse: menuMsg
                    });
                    await this.sendKeepingUnread(() => client.sendText(message.from, menuMsg), message.from, menuMsg);
                    return;
                }
                
                // Verifica se está no submenu de suporte e processa comandos especiais
                if (this.inSupportSubmenu.get(message.from) === true) {
                    // Tratamento para "#" ou "#voltar" - Voltar ao menu anterior
                    if (textLower.trim() === '#' || textLower.trim() === '#voltar' || textLower.trim() === '#0') {
                        console.log(`⬅️ Cliente voltou do submenu de suporte`);
                        this.inSupportSubmenu.delete(message.from);
                        this.userStates.delete(message.from); // Limpa dados antigos
                        const menuMsg = `*COMO POSSO AJUDAR?*

*1️⃣ PAGAMENTO / SEGUNDA VIA*

*2️⃣ SUPORTE TÉCNICO*

*3️⃣ FALAR COM ATENDENTE*

*4️⃣ OUTRAS DÚVIDAS*

Digite o *número* da opção`;
                        // Atualiza contexto: voltou ao menu principal - LIMPA completamente
                        this.updateConversationContext(message.from, {
                            currentMenu: 'main',
                            currentStep: null,
                            lastAction: 'back_to_main_menu',
                            lastResponse: menuMsg,
                            lastMessage: null,
                            lastIntent: null
                        });
                        await this.sendKeepingUnread(() => client.sendText(message.from, menuMsg), message.from, menuMsg);
                        return;
                    }
                    
                    // Tratamento para "9" ou "#finalizar" - Finalizar atendimento
                    if (textLower.trim() === '9' || textLower.trim() === '#finalizar' || textLower.trim() === '#9') {
                        console.log(`🏁 Cliente finalizou atendimento`);
                        const response = `*Atendimento finalizado.*

Obrigado por nos contactar! 🎉`;
                        await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                        this.inSupportSubmenu.delete(message.from);
                        return;
                    }
                }
                
                // Verifica se está no menu de pagamento e processa comandos especiais
                if (conversationContext.currentMenu === 'payment') {
                    // Tratamento para "#" ou "#voltar" - Voltar ao menu anterior
                    if (textLower.trim() === '#' || textLower.trim() === '#voltar' || textLower.trim() === '#0') {
                        console.log(`⬅️ Cliente voltou do menu de pagamento`);
                        this.userStates.delete(message.from); // Limpa dados antigos
                        const menuMsg = `*COMO POSSO AJUDAR?*

*1️⃣ PAGAMENTO / SEGUNDA VIA*

*2️⃣ SUPORTE TÉCNICO*

*3️⃣ FALAR COM ATENDENTE*

*4️⃣ OUTRAS DÚVIDAS*

Digite o *número* da opção`;
                        // Atualiza contexto: voltou ao menu principal - LIMPA completamente
                        this.updateConversationContext(message.from, {
                            currentMenu: 'main',
                            currentStep: null,
                            lastAction: 'back_to_main_menu',
                            lastResponse: menuMsg,
                            lastMessage: null,
                            lastIntent: null
                        });
                        await this.sendKeepingUnread(() => client.sendText(message.from, menuMsg), message.from, menuMsg);
                        return;
                    }
                    
                    // Tratamento para "#finalizar" - Finalizar atendimento
                    if (textLower.trim() === '#finalizar' || textLower.trim() === '#9') {
                        console.log(`🏁 Cliente finalizou atendimento`);
                        const response = `*Atendimento finalizado.*

Obrigado por nos contactar! 🎉`;
                        await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                        this.updateConversationContext(message.from, {
                            currentMenu: 'main',
                            currentStep: null
                        });
                        return;
                    }
                }
                
                // Opção 0 - Voltar (só funciona se não estiver em nenhum submenu)
                if (textLower.trim() === '0' && 
                    this.inSupportSubmenu.get(message.from) !== true && 
                    conversationContext.currentMenu === 'main') {
                    this.userStates.delete(message.from); // Limpa dados antigos
                    const menuMsg = `*COMO POSSO AJUDAR?*

*1️⃣ PAGAMENTO / SEGUNDA VIA*

*2️⃣ SUPORTE TÉCNICO*

*3️⃣ FALAR COM ATENDENTE*

*4️⃣ OUTRAS DÚVIDAS*

Digite o *número* da opção`;
                    // Atualiza contexto: voltou ao menu principal - LIMPA completamente
                    this.updateConversationContext(message.from, {
                        currentMenu: 'main',
                        currentStep: null,
                        lastAction: 'back_to_main_menu',
                        lastResponse: menuMsg,
                        lastMessage: null,
                        lastIntent: null
                    });
                    await this.sendKeepingUnread(() => client.sendText(message.from, menuMsg), message.from, menuMsg);
                    return;
                }
                
                // Verifica se está no menu outras dúvidas e processa comandos especiais
                if (conversationContext.currentMenu === 'other') {
                    // Tratamento para "#" ou "#voltar" - Voltar ao menu anterior
                    if (textLower.trim() === '#' || textLower.trim() === '#voltar' || textLower.trim() === '#0') {
                        console.log(`⬅️ Cliente voltou do menu outras dúvidas`);
                        this.userStates.delete(message.from); // Limpa dados antigos
                        const menuMsg = `*COMO POSSO AJUDAR?*

*1️⃣ PAGAMENTO / SEGUNDA VIA*

*2️⃣ SUPORTE TÉCNICO*

*3️⃣ FALAR COM ATENDENTE*

*4️⃣ OUTRAS DÚVIDAS*

Digite o *número* da opção`;
                        // Atualiza contexto: voltou ao menu principal - LIMPA completamente
                        this.updateConversationContext(message.from, {
                            currentMenu: 'main',
                            currentStep: null,
                            lastAction: 'back_to_main_menu',
                            lastResponse: menuMsg,
                            lastMessage: null,
                            lastIntent: null
                        });
                        await this.sendKeepingUnread(() => client.sendText(message.from, menuMsg), message.from, menuMsg);
                        return;
                    }
                    
                    // Tratamento para "#finalizar" - Finalizar atendimento
                    if (textLower.trim() === '#finalizar' || textLower.trim() === '#9') {
                        console.log(`🏁 Cliente finalizou atendimento`);
                        const response = `*Atendimento finalizado.*

Obrigado por nos contactar! 🎉`;
                        await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
                        this.updateConversationContext(message.from, {
                            currentMenu: 'main',
                            currentStep: null
                        });
                        return;
                    }
                }
                
                const hasPaymentWord = ['paguei', 'pago', 'pagamento', 'paguei', 'fiz o pagamento'].some(kw => textLower.includes(kw));
                const hasProblem = [
                    'ainda n', 'ainda não', 'ainda nao', 'ainda não liberou', 'ainda nao liberou',
                    'não liberou', 'nao liberou', 'n liberou', 'não funciona', 'nao funciona',
                    'n funciona', 'não voltou', 'nao voltou', 'n voltou', 'problema', 'erro'
                ].some(pi => textLower.includes(pi));
                
                // Se tem pagamento E problema, pausa bot e não responde
                if (hasPaymentWord && hasProblem) {
                    console.log(`⚠️ Cliente reportou pagamento com problema - bot pausado: "${text.substring(0, 50)}..."`);
                    await this.pauseBotForChat(message.from, false); // Não envia mensagem, atendente vai investigar
                    return; // Não responde nada
                }
                
                // Caso contrário, ignora normalmente
                console.log(`💬 Intenção não clara, mensagem ignorada (conversa normal): "${text.substring(0, 50)}..."`);
                return;
            }
            
            // 4. Solicitação clara de boleto/PIX - processa comandos
            // Continua o fluxo abaixo para processar solicitação
            // (Menu já foi processado acima, então não precisa verificar novamente aqui)
            
            // Processamento geral de PIX (fora do fluxo novo)
            if (textLower.includes('pix')) {
                const ctx = this.userStates.get(message.from);
                if (!ctx) {
                    const response = `*PAGAMENTO COM PIX*

Para gerar o QR Code PIX, envie seu *CPF* (somente números)

*# VOLTAR* ou *# FINALIZAR ATENDIMENTO*`;
                    // Atualiza contexto: esperando CPF para PIX
                    this.updateConversationContext(message.from, {
                        currentMenu: 'payment',
                        currentStep: 'waiting_cpf',
                        lastAction: 'request_pix',
                        lastResponse: response
                    });
                    await this.sendKeepingUnread(() => client.sendText(message.from, response), message.from, response);
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
                        await this.sendKeepingUnread(() => client.sendText(message.from, parsed.payload), message.from, parsed.payload);
                        try { messageStore.recordOutgoingMessage({ chatId: message.from, text: parsed.payload }); } catch (_) {}
                        
                        // Envia imagem com instruções de como copiar o código PIX corretamente
                        await new Promise(resolve => setTimeout(resolve, 500));
                        await this.sendPixInstructionsImage(message.from);
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
                    const postPixMsg = `*PIX ENVIADO!*

⏱️ *Liberação em até 5 minutos*

*Se após 5 minutos não houve liberação automática:*

*• Desligue e ligue o roteador*
*• Aguarde a reconexão*

📞 *Não voltou?* Digite *"3"*

📱 *Digite 8 para voltar ao menu*`;
                    
                    // Atualiza contexto: PIX enviado, aguardando confirmação
                    this.updateConversationContext(message.from, {
                        currentStep: 'waiting_payment_confirmation',
                        lastAction: 'sent_pix',
                        lastResponse: postPixMsg
                    });
                    
                    await this.sendKeepingUnread(() => client.sendText(message.from, postPixMsg), message.from, postPixMsg);
                    
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
                const reply = `*PAGAMENTO / SEGUNDA VIA*

Para gerar seu boleto ou PIX, envie seu *CPF* (somente números)

*# VOLTAR* ou *# FINALIZAR ATENDIMENTO*`;
                
                // Atualiza contexto: menu de pagamento, aguardando CPF
                this.updateConversationContext(message.from, {
                    currentMenu: 'payment',
                    currentStep: 'waiting_cpf',
                    lastAction: 'show_payment_menu',
                    lastResponse: reply
                });
                
                // SEMPRE responde com áudio quando é sobre pagamento/internet (mesmo se cliente enviou texto)
                await this.sendKeepingUnread(() => client.sendText(message.from, reply), message.from, reply);
            }
            } catch (err) {
                console.error('❌ Erro ao processar mensagem:', err);
                console.error('📋 Stack trace:', err.stack);
                // Não bloqueia outras mensagens mesmo se uma der erro
            }
        });

        // Eventos opcionais de sessão (removidos: onLogout/onRemoved não existem nesta API)

        // Listener extra para manter o processo sempre com eventos ativos
        client.onAnyMessage((m) => {
            try {
                // Ignora grupos
                if (m.isGroupMsg === true || m.from?.includes('@g.us')) return;
                // Ignora mensagens de status/stories (várias verificações)
                if (m.isStatus === true || 
                    m.from === 'status@broadcast' || 
                    m.from?.includes('status') || 
                    m.isStory === true || 
                    m.type === 'status' ||
                    m.type === 'ptt' && m.from?.includes('broadcast') ||
                    m.chatId?.includes('status@')) return;
                // Se mensagem foi enviada pelo próprio WhatsApp (atendente no celular/WhatsApp Web)
                if (m.fromMe === true && typeof m.body === 'string' && m.body.trim().length > 0) {
                    // IGNORA mensagens com base64 longo (provavelmente confirmação de envio de arquivo)
                    if (this.isBase64String(m.body)) {
                        return; // Ignora silenciosamente
                    }
                    
                    // Evita duplicidade com mensagens já gravadas pelo painel/bot
                    const targetChatId = m.chatId || m.to || m.from;
                    // Aumenta janela de verificação para 30 segundos para evitar duplicatas
                    const exists = messageStore.hasSimilarRecentOutgoing(targetChatId, m.body.trim(), 30000);
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
        
        // Ignora URLs, IPs e links
        const textLower = text.toLowerCase().trim();
        if (textLower.startsWith('http://') || 
            textLower.startsWith('https://') || 
            textLower.startsWith('www.') ||
            textLower.includes('://') ||
            /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(textLower) ||
            textLower.includes('.com') ||
            textLower.includes('.br') ||
            textLower.includes('.net') ||
            textLower.includes('.org')) {
            return null; // É URL/link, não processa como CPF
        }
        
        // Remove caracteres não numéricos e junta os dígitos
        const digits = (text.match(/\d/g) || []).join('');
        
        // CPF deve ter exatamente 11 dígitos, CNPJ 14 dígitos
        // Mas também aceita se tiver apenas números e o tamanho correto
        if (digits.length === 11) {
            return digits; // CPF
        } else if (digits.length === 14) {
            return digits; // CNPJ
        } else if (digits.length > 11 && digits.length < 14) {
            // Se tiver entre 12-13 dígitos, pode ser CPF com alguns caracteres extras, pega só os 11 primeiros
            return digits.slice(0, 11);
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
    async sendKeepingUnread(sendFn, chatId, messageText = null) {
        try {
            // Anti-duplicação: se uma mensagem idêntica acabou de ser enviada/salva, não envia de novo
            try {
                if (messageText && chatId) {
                    const alreadyExists = messageStore.hasSimilarRecentOutgoing(chatId, String(messageText), 5000);
                    if (alreadyExists) {
                        return { skipped: true };
                    }
                }
            } catch (_) {}
            // Garante bloqueio de leitura antes de enviar
            try { await this.injectNoRead(); } catch (_) {}
            const result = await sendFn();
            
            // Registra mensagem enviada no painel (se texto foi fornecido)
            if (messageText && chatId) {
                try {
                    // Tenta obter o nome do contato para atualizar o chat
                    let contactName = '';
                    try {
                        if (this.client && typeof this.client.getContact === 'function') {
                            const contact = await this.client.getContact(chatId);
                            contactName = contact?.pushname || contact?.name || '';
                        }
                    } catch (_) {
                        // Se falhar ao obter nome, usa string vazia
                    }
                    
                    messageStore.recordOutgoingMessage({
                        chatId: chatId,
                        text: messageText,
                        timestamp: Date.now()
                    });
                    
                    // Atualiza o nome do chat se obtivemos o nome do contato
                    if (contactName) {
                        try {
                            messageStore.upsertChat(chatId, contactName);
                        } catch (_) {}
                    }
                } catch (err) {
                    // Não bloqueia o envio se falhar ao registrar
                    console.error('Erro ao registrar mensagem enviada:', err);
                }
            }
            
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

    /**
     * Envia imagem com instruções de como copiar o código PIX corretamente
     * @param {string} chatId - ID do chat
     */
    async sendPixInstructionsImage(chatId) {
        try {
            const imagesDir = path.join(__dirname, 'images');
            if (!fs.existsSync(imagesDir)) {
                fs.mkdirSync(imagesDir, { recursive: true });
            }
            
            const imagePath = path.join(imagesDir, 'instrucoes_pix.png');
            
            // Verifica se a imagem existe
            if (!fs.existsSync(imagePath)) {
                console.log('⚠️ Imagem de instruções PIX não encontrada. Adicione o arquivo instrucoes_pix.png na pasta images/');
                // Envia mensagem de instruções como texto caso a imagem não exista
                const instructionsMsg = `*📋 COMO COPIAR O CÓDIGO PIX:*

*✅ FORMA CORRETA:*
*1.* Pressione e segure na mensagem do código
*2.* Selecione "Copiar" no menu
*3.* Cole no app do seu banco

*❌ NÃO FAÇA:*
*• Não clique diretamente no código
*• Não copie partes do código

*⚠️ IMPORTANTE:*
Copie o código COMPLETO, do início ao fim!`;
                await this.sendKeepingUnread(() => this.client.sendText(chatId, instructionsMsg), chatId, instructionsMsg);
                return;
            }
            
            // Envia a imagem com caption explicativo
            const caption = `*📋 COMO COPIAR O CÓDIGO PIX:*

*✅ FORMA CORRETA:*
*1.* Pressione e segure na mensagem do código
*2.* Selecione "Copiar" no menu
*3.* Cole no app do seu banco

*❌ NÃO FAÇA:*
*• Não clique diretamente no código
*• Não copie partes do código

*⚠️ IMPORTANTE:*
Copie o código COMPLETO, do início ao fim!`;
            
            await this.sendKeepingUnread(() => this.client.sendImage(chatId, imagePath, 'instrucoes_pix.png', caption), chatId, caption);
            
            // Registra no banco
            try {
                const fileId = `instrucoes_pix_${Date.now()}`;
                const filesDir = path.join(__dirname, 'files');
                if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
                
                // Copia imagem para pasta files para exibição no painel
                const destPath = path.join(filesDir, `${fileId}.png`);
                fs.copyFileSync(imagePath, destPath);
                
                messageStore.recordOutgoingMessage({
                    chatId: chatId,
                    text: caption,
                    timestamp: Date.now(),
                    fileId: fileId,
                    fileName: 'instrucoes_pix.png',
                    fileType: 'image/png'
                });
            } catch (_) {
                try { messageStore.recordOutgoingMessage({ chatId: chatId, text: caption, timestamp: Date.now() }); } catch (_) {}
            }
        } catch (e) {
            console.error('Erro ao enviar imagem de instruções PIX:', e);
            // Fallback: envia apenas texto se imagem falhar
            try {
                const instructionsMsg = `*📋 COMO COPIAR O CÓDIGO PIX:*

*✅ FORMA CORRETA:*
*1.* Pressione e segure na mensagem do código
*2.* Selecione "Copiar" no menu
*3.* Cole no app do seu banco

*❌ NÃO FAÇA:*
*• Não clique diretamente no código
*• Não copie partes do código

*⚠️ IMPORTANTE:*
Copie o código COMPLETO, do início ao fim!`;
                await this.sendKeepingUnread(() => this.client.sendText(chatId, instructionsMsg), chatId, instructionsMsg);
            } catch (_) {}
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

            // SALVA MENSAGEM NO BANCO ANTES de tentar enviar
            // Isso garante que mesmo se o envio falhar, a mensagem aparecerá no painel
            try {
                let contactName = '';
                try {
                    if (this.client && typeof this.client.getContact === 'function') {
                        const contact = await this.client.getContact(chatId);
                        contactName = contact?.pushname || contact?.name || '';
                    }
                } catch (_) {}

                messageStore.recordOutgoingMessage({
                    chatId: chatId,
                    text: text,
                    timestamp: Date.now()
                });
                
                console.log(`💾 Mensagem salva no banco para ${chatId}: "${text.substring(0, 30)}..."`);

                if (contactName) {
                    try {
                        messageStore.upsertChat(chatId, contactName);
                    } catch (_) {}
                }
            } catch (err) {
                // Não bloqueia se falhar ao salvar
                console.error('Erro ao salvar mensagem no banco:', err);
            }

            // Agora tenta enviar a mensagem
            try {
                // Envia mensagem usando sendKeepingUnread para não marcar como lida
                // Não passa o texto novamente para evitar duplicação no banco
                const result = await this.sendKeepingUnread(
                    () => this.client.sendText(chatId, text),
                    chatId,
                    null // Não registra novamente (já foi salvo acima)
                );

                console.log(`📤 Mensagem enviada para ${chatId}: ${text.substring(0, 50)}...`);
                return result;
            } catch (sendError) {
                // Mesmo se falhar o envio, a mensagem já está salva no banco
                console.error('⚠️ Erro ao enviar via WhatsApp (mas mensagem já salva no banco):', sendError.message || sendError);
                // Retorna sucesso parcial - mensagem salva mas não enviada
                return { id: null, saved: true };
            }
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
     * Pausa o bot para um chat específico (inicia atendimento humano)
     * @param {string} chatId - ID do chat
     * @param {boolean} sendMessage - Se deve enviar mensagem ao cliente (padrão: true)
     */
    async pauseBotForChat(chatId, sendMessage = true) {
        const wasPaused = this.humanAttending.get(chatId) === true;
        
        this.humanAttending.set(chatId, true);
        this.humanAttendingTime.set(chatId, Date.now());
        
        // Salva no banco de dados
        try {
            messageStore.setBotPaused(chatId, true);
        } catch (e) {
            console.error('Erro ao salvar estado de pausa no banco:', e);
        }
        
        console.log(`⏸️ Bot pausado para chat ${chatId} pelo atendente.`);
        
        // Mensagem automática removida - atendente assume sem aviso ao cliente
    }

    isBotPausedForChat(chatId) {
        // Verifica no banco também para garantir consistência
        try {
            const dbPaused = messageStore.isBotPaused(chatId);
            const memoryPaused = this.humanAttending.get(chatId) === true;
            
            // Se há divergência, corrige
            if (dbPaused !== memoryPaused) {
                this.humanAttending.set(chatId, dbPaused);
                if (dbPaused) {
                    this.humanAttendingTime.set(chatId, Date.now());
                }
            }
            
            return dbPaused || memoryPaused;
        } catch (e) {
            return this.humanAttending.get(chatId) === true;
        }
    }

    /**
     * Reativa o bot para um chat específico (finaliza atendimento humano)
     * @param {string} chatId - ID do chat
     * @param {boolean} sendMessage - Se deve enviar mensagem ao cliente (padrão: true)
     */
    async reactivateBotForChat(chatId, sendMessage = true) {
        const wasPaused = this.humanAttending.get(chatId) === true;
        
        this.humanAttending.set(chatId, false);
        this.humanAttendingTime.delete(chatId);
        
        // Salva no banco de dados
        try {
            messageStore.setBotPaused(chatId, false);
        } catch (e) {
            console.error('Erro ao salvar estado de reativação no banco:', e);
        }
        
        console.log(`🤖 Bot reativado para chat ${chatId} pelo atendente.`);
        
        // Mensagem automática removida - reativação silenciosa
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

    cleanupAbandonedAttendances() {
        try {
            const now = Date.now();
            const maxAge = 15 * 60 * 1000; // 15 minutos (aumentado de 5 para 15)
            
            // Verifica atendimentos ativos abandonados
            // Agora verifica última mensagem do atendente do banco, não apenas quando foi pausado
            for (const [chatId, pausedTimestamp] of this.humanAttendingTime.entries()) {
                if (!this.humanAttending.get(chatId)) continue; // Não está pausado, pula
                
                // Obtém última mensagem do atendente do banco
                const lastAttendantMsg = messageStore.getLastAttendantMessage(chatId);
                const timeSinceLastAttendantMsg = lastAttendantMsg ? (now - lastAttendantMsg) : (now - pausedTimestamp);
                
                // Se atendente não enviou mensagem há mais de 15 minutos, reativa bot
                if (timeSinceLastAttendantMsg > maxAge) {
                    console.log(`🤖 Atendimento humano abandonado há ${Math.floor(timeSinceLastAttendantMsg / 60000)} minutos - bot reativado automaticamente para ${chatId}`);
                    this.reactivateBotForChat(chatId, false); // Reativação silenciosa
                }
            }
        } catch (e) {
            console.error('Erro ao limpar atendimentos abandonados:', e);
        }
    }

    /**
     * Limpa contextos de conversa antigos (inativos há 30+ minutos)
     */
    cleanupOldContexts() {
        try {
            const now = Date.now();
            const maxAge = 30 * 60 * 1000; // 30 minutos
            
            for (const [chatId, context] of this.conversationContext.entries()) {
                if (context.updatedAt && (now - context.updatedAt > maxAge)) {
                    this.conversationContext.delete(chatId);
                }
            }
        } catch (e) {
            console.error('Erro ao limpar contextos antigos:', e);
        }
    }

    /**
     * Obtém o contexto atual da conversa para um chat
     */
    getConversationContext(chatId) {
        if (!this.conversationContext.has(chatId)) {
            this.conversationContext.set(chatId, {
                currentMenu: 'main',
                currentStep: null,
                lastIntent: null,
                lastAction: null,
                conversationHistory: [],
                lastMessage: null,
                lastResponse: null,
                updatedAt: Date.now()
            });
        }
        return this.conversationContext.get(chatId);
    }

    /**
     * Atualiza o contexto da conversa
     */
    updateConversationContext(chatId, updates) {
        const context = this.getConversationContext(chatId);
        const now = Date.now();
        
        // Atualiza campos
        Object.assign(context, updates, { updatedAt: now });
        
        // Mantém histórico das últimas 10 ações (se especificado)
        if (updates.lastAction) {
            context.conversationHistory.push({
                action: updates.lastAction,
                intent: updates.lastIntent || context.lastIntent,
                timestamp: now
            });
            // Mantém apenas últimas 10 ações
            if (context.conversationHistory.length > 10) {
                context.conversationHistory.shift();
            }
        }
        
        return context;
    }

    /**
     * Verifica se uma intenção faz sentido no contexto atual da conversa
     * Retorna true se a intenção é válida no contexto, false caso contrário
     */
    isContextValid(intent, chatId, messageText) {
        const context = this.getConversationContext(chatId);
        const text = (messageText || '').toLowerCase().trim();
        
        // Se está em um submenu específico, verifica se a intenção faz sentido
        if (context.currentMenu === 'support_sub') {
            // No submenu de suporte, só aceita opções válidas ou comandos especiais
            const validOptions = ['1', '2', '3', '9', '#', '#voltar', '#finalizar', '#0', '#9'];
            const isMenuOption = validOptions.includes(text) || text.includes('internet') || text.includes('paguei');
            
            // Se não é uma opção válida do menu, mas tem intenção clara de algo diferente
            // Pode ser fora de contexto - verifica com histórico
            if (!isMenuOption && intent !== 'unclear') {
                // Verifica se a intenção mudou drasticamente do último contexto
                if (context.lastIntent && context.lastIntent !== intent && 
                    !['support_slow', 'support_dropped', 'confirm_payment'].includes(intent)) {
                    // Contexto pode estar desatualizado - permite mas atualiza
                    return true; // Permite mas atualizará contexto
                }
            }
            return true; // Permite opções do menu
        }
        
        // Se está esperando CPF
        if (context.currentStep === 'waiting_cpf') {
            // Aceita CPF, menu, ou comandos de cancelamento
            const isCpf = /^\d{11,14}$/.test(text);
            const isCancel = text === 'menu' || text === 'cancelar' || text === '0' || text === '#';
            if (isCpf || isCancel || intent === 'request_payment') {
                return true;
            }
            // Se intenção mudou drasticamente, pode ser fora de contexto
            if (intent !== 'unclear' && intent !== context.lastIntent && intent !== 'request_payment') {
                return false; // Fora de contexto
            }
        }
        
        // Se está esperando PIX
        if (context.currentStep === 'waiting_pix') {
            const isPix = text === 'pix' || text.includes('pix');
            const isCancel = text === 'menu' || text === 'cancelar' || text === '0' || text === '#';
            if (isPix || isCancel || intent === 'request_payment') {
                return true;
            }
        }
        
        // Verifica mudanças bruscas de contexto
        if (context.lastIntent && context.lastIntent !== 'unclear' && intent !== context.lastIntent) {
            // Se a última ação foi enviar menu e agora veio algo totalmente diferente sem comando de menu
            if (context.lastAction === 'send_menu' && intent !== 'unclear' && !['1', '2', '3', '4', '9'].includes(text)) {
                // Pode ser fora de contexto - mas permite se intenção é clara
                if (intent === 'request_payment' || intent === 'confirm_payment') {
                    return true; // Permite solicitações claras
                }
            }
        }
        
        // Por padrão, permite se não há conflito claro
        return true;
    }
}

module.exports = WhatsAppBot;


