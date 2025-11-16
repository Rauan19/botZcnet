// Bot baseado em whatsapp-web.js
// Objetivos atendidos:
// - Não marcar mensagens como lidas automaticamente
// - Não aparecer como online/digitando/gravação
// - Receber mensagens normalmente e responder
// - Código limpo, comentado e fácil de manter
// - Sistema robusto de reconexão automática

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const zcBillService = require('./services/zcBillService');
const zcClientService = require('./services/zcClientService');
const messageStore = require('./database');
const contextAnalyzer = require('./services/contextAnalyzer');
const audioTranscription = require('./services/audioTranscription');
const audioSynthesis = require('./services/audioSynthesis');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

let ffmpegStaticPath = null;
try {
    ffmpegStaticPath = require('ffmpeg-static');
} catch (_) {
    ffmpegStaticPath = null;
}

const envFfmpegPath = process.env.FFMPEG_PATH || process.env.FFMPEG_BIN || null;
const resolvedFfmpegPath = envFfmpegPath || ffmpegStaticPath;
const hasFfmpegBinary = Boolean(resolvedFfmpegPath && fs.existsSync(resolvedFfmpegPath));

if (hasFfmpegBinary) {
    ffmpeg.setFfmpegPath(resolvedFfmpegPath);
    console.log(`🎬 ffmpeg configurado em: ${resolvedFfmpegPath}`);
} else {
    console.warn('⚠️ ffmpeg não encontrado. Áudios podem ser enviados como arquivo.');
}

class WhatsAppBot {
    constructor() {
        this.client = null; // Instância do cliente whatsapp-web.js
        this.started = false;
        this.qrCode = null; // Guarda QR code para exibição
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
     * Inicia o bot criando a sessão whatsapp-web.js com as opções pedidas.
     */
    async start() {
        if (this.started) return;

        console.log('🔄 Iniciando bot WhatsApp (whatsapp-web.js)...');

        // Limpa processos órfãos antes de iniciar (opcional via env)
        if (process.env.KILL_ORPHAN_BROWSERS === '1') {
            await this.killOrphanBrowsers();
        }

        // Cria cliente com autenticação local (salva sessão em tokens/)
        const sessionName = process.env.WHATSAPP_SESSION || 'zcnet-bot';
        this.client = new Client({
            authStrategy: new LocalAuth({
                clientId: sessionName,
                dataPath: path.join(__dirname, 'tokens')
            }),
            puppeteer: {
                headless: true,
                args: [
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
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
            },
            webVersionCache: {
                type: 'remote',
                remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2413.51-beta.html',
            },
            // IMPORTANTE: whatsapp-web.js por padrão NÃO marca mensagens como lidas
            // O comportamento padrão já mantém mensagens não lidas, então não precisa configurar nada
            // Mas garantimos isso através do injectNoRead() que bloqueia todas as tentativas de leitura
        });

        // Evento: QR Code gerado
        this.client.on('qr', (qr) => {
            console.log('📱 QR Code gerado, escaneie com seu WhatsApp');
            this.qrCode = qr;
            // Converte QR para base64 para compatibilidade com API existente
            const qrTerminal = require('qrcode-terminal');
            qrTerminal.generate(qr, { small: true });
        });

        // Evento: Cliente pronto
        this.client.on('ready', () => {
            console.log('✅ Bot WhatsApp conectado com sucesso (whatsapp-web.js)!');
            console.log('👻 Invisível e sem leitura automática configurado.');
            this.started = true;
            
            // Carrega estado de pausa do banco de dados
            this.loadPausedChatsFromDatabase();
            
            // Injeção inicial para bloquear leituras
            this.injectNoRead().catch(() => {});
            
            // Reaplica bloqueios periodicamente
            if (!this._reinjectTicker) {
                this._reinjectTicker = setInterval(() => {
                    this.injectNoRead().catch(() => {});
                }, 5000);
            }
        });

        // Evento: Autenticação falhou
        this.client.on('auth_failure', (msg) => {
            console.error('❌ Falha na autenticação:', msg);
            this.started = false;
        });

        // Evento: Cliente desconectado
        this.client.on('disconnected', (reason) => {
            console.log(`⚠️ Cliente desconectado: ${reason}`);
            this.started = false;
            
            // Tenta reconectar automaticamente
            if (reason === 'NAVIGATION') {
                console.log('🔄 Tentando reconectar em 5 segundos...');
                setTimeout(() => {
                    this.start().catch((e) => console.error('❌ Falha ao reconectar:', e));
                }, 5000);
            }
        });

        // Configura listeners antes de inicializar
        this.setupListeners();

        // Inicializa o cliente
        await this.client.initialize();
    }

    /**
     * Retorna o último QR capturado (Buffer e contentType) ou null
     * Retorna uma Promise que resolve com o buffer ou null
     */
    async getLastQr() {
        if (!this.qrCode) return null;
        try {
            // whatsapp-web.js retorna QR como string, precisa converter para imagem
            const QRCode = require('qrcode');
            const buffer = await QRCode.toBuffer(this.qrCode);
            return {
                contentType: 'image/png',
                buffer: buffer
            };
        } catch (e) {
            return null;
        }
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
        if (!client) return;

        // Mudança de estado do cliente (whatsapp-web.js usa eventos diferentes)
        client.on('change_state', async (state) => {
            console.log(`🔁 Estado do cliente: ${state}`);
            // Reaplica bloqueio de leitura quando conectado
            if (state === 'CONNECTED') {
                try { await this.injectNoRead(); } catch (_) {}
            }
            // Watchdog: se desconectar, recria a sessão
            if (state === 'DISCONNECTED' || state === 'UNPAIRED') {
                try {
                    console.log('🧯 Detected session drop. Restarting client in 3s...');
                    await this.stop();
                } catch (_) {}
                setTimeout(() => {
                    this.start().catch((e) => console.error('❌ Falha ao reiniciar cliente:', e));
                }, 3000);
            }
        });

        // Recebimento de mensagens
        client.on('message', async (message) => {
            await this.handleIncomingMessageCompat(message, { adapter: 'wweb', client });
        });

        // Eventos opcionais de sessão (removidos: onLogout/onRemoved não existem nesta API)

        // whatsapp-web.js não tem onAnyMessage, mas o listener 'message' já captura todas as mensagens

        // Verificador de conexão periódico (reduzido para não poluir logs)
        this.connectionTicker = setInterval(async () => {
            try {
                if (!this.client) return;
                const state = await this.client.getState();
                if (state !== 'CONNECTED') {
                    console.log(`⚠️ Conexão perdida! Estado: ${state}`);
                    // Tenta reconectar automaticamente
                    try {
                        console.log('🔄 Tentando reconectar automaticamente...');
                        await this.reconnect();
                    } catch (e) {
                        console.error('❌ Falha na reconexão automática:', e.message);
                    }
                }
            } catch (e) {
                // Ignora erros silenciosamente para não poluir logs
            }
        }, 60000); // Verifica a cada 1 minuto

        // Watchdog anti-zombie: verifica conexão real a cada 5 minutos
        this.zombieWatchdog = setInterval(async () => {
            try {
                if (!this.client || !this.started) return;
                
                const state = await this.client.getState();
                if (state !== 'CONNECTED') {
                    console.log('🔍 Watchdog: Conexão não está ativa, reconectando...');
                    await this.reconnect();
                    return;
                }
                
                // Testa se consegue fazer uma operação real (tenta pegar lista de chats)
                // Se falhar, pode estar "zombie" (conectado mas não funcional)
                try {
                    await Promise.race([
                        this.client.getChats(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
                    ]);
                    // Se chegou aqui, a conexão está funcionando de verdade
                    console.log('✅ Watchdog: Conexão verificada e funcionando');
                } catch (e) {
                    // Se falhar ou der timeout, pode estar "zombie"
                    if (e.message && e.message.includes('timeout')) {
                        console.log('⚠️ Watchdog: Timeout ao verificar conexão (possível "zombie"), reconectando...');
                    } else {
                        console.log('⚠️ Watchdog: Erro ao verificar conexão (possível "zombie"), reconectando...');
                    }
                    await this.reconnect();
                }
            } catch (e) {
                console.error('❌ Erro no watchdog anti-zombie:', e.message);
            }
        }, 5 * 60 * 1000); // Verifica a cada 5 minutos
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

    // ===== Métodos auxiliares para compatibilidade com API =====
    
    /**
     * Envia mensagem de texto (wrapper para compatibilidade)
     * IMPORTANTE: Não marca mensagens como lidas
     */
    async sendText(chatId, text) {
        if (!this.client) throw new Error('Cliente não está conectado');
        // Bloqueia leitura ANTES de enviar
        try { await this.injectNoRead(); } catch (_) {}
        const result = await this.client.sendMessage(chatId, text);
        if (result && result.id) {
            result.id = this.normalizeMessageId(result.id);
        }
        // Bloqueia leitura DEPOIS de enviar (previne marcação automática)
        try { await this.injectNoRead(); } catch (_) {}
        return result;
    }
    
    /**
     * Envia arquivo (wrapper para compatibilidade)
     * IMPORTANTE: Não marca mensagens como lidas
     */
    async sendFile(chatId, filePath, fileName, caption = '') {
        if (!this.client) throw new Error('Cliente não está conectado');
        // Bloqueia leitura ANTES de enviar
        try { await this.injectNoRead(); } catch (_) {}
        const media = MessageMedia.fromFilePath(filePath);
        const result = await this.client.sendMessage(chatId, media, { caption });
        if (result && result.id) {
            result.id = this.normalizeMessageId(result.id);
        }
        // Bloqueia leitura DEPOIS de enviar (previne marcação automática)
        try { await this.injectNoRead(); } catch (_) {}
        return result;
    }

    async ensureOggOpusFile(audioPath) {
        if (!hasFfmpegBinary) {
            console.warn('[sendPtt] ffmpeg indisponível. Enviando áudio original.');
            return { finalPath: audioPath, cleanup: false };
        }
        const ext = path.extname(audioPath || '').toLowerCase();
        if (ext === '.ogg') {
            return { finalPath: audioPath, cleanup: false };
        }

        const tempDir = path.join(__dirname, 'temp_audio');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const baseName = path.basename(audioPath || 'audio');
        const tempPath = path.join(tempDir, `${baseName}_${Date.now()}.ogg`);
        console.log(`[sendPtt] Convertendo áudio para OGG/Opus: ${audioPath} -> ${tempPath}`);

        await new Promise((resolve, reject) => {
            ffmpeg(audioPath)
                .toFormat('ogg')
                .audioCodec('libopus')
                .audioBitrate(32)
                .audioChannels(1)
                .audioFrequency(16000)
                .on('end', resolve)
                .on('error', (err) => {
                    console.error('[sendPtt] Erro ao converter áudio para OGG:', err);
                    reject(err);
                })
                .save(tempPath);
        });

        return { finalPath: tempPath, cleanup: true };
    }
    
    /**
     * Envia áudio PTT (wrapper para compatibilidade)
     * IMPORTANTE: Não marca mensagens como lidas
     */
    async sendPtt(chatId, audioPath) {
        if (!this.client) throw new Error('Cliente não está conectado');
        // Bloqueia leitura ANTES de enviar
        try { await this.injectNoRead(); } catch (_) {}
        const { finalPath, cleanup } = await this.ensureOggOpusFile(audioPath);
        const audioBuffer = fs.readFileSync(finalPath);
        const baseName = path.basename(finalPath);
        const media = new MessageMedia(
            'audio/ogg; codecs=opus',
            audioBuffer.toString('base64'),
            baseName.endsWith('.ogg') ? baseName : 'voz.ogg'
        );
        const result = await this.client.sendMessage(chatId, media, {
            sendAudioAsVoice: true,
            ptt: true
        });
        if (result && result.id) {
            result.id = this.normalizeMessageId(result.id);
        }
        // Bloqueia leitura DEPOIS de enviar (previne marcação automática)
        try { await this.injectNoRead(); } catch (_) {}
        if (cleanup) {
            try { fs.unlinkSync(finalPath); } catch (_) {}
        }
        return result;
    }
    
    /**
     * Envia imagem de base64 (wrapper para compatibilidade)
     * IMPORTANTE: Não marca mensagens como lidas
     */
    async sendImageFromBase64(chatId, base64Image, filename, caption = '') {
        if (!this.client) throw new Error('Cliente não está conectado');
        // Bloqueia leitura ANTES de enviar
        try { await this.injectNoRead(); } catch (_) {}
        const media = new MessageMedia('image/png', base64Image, filename);
        const result = await this.client.sendMessage(chatId, media, { caption });
        if (result && result.id) {
            result.id = this.normalizeMessageId(result.id);
        }
        // Bloqueia leitura DEPOIS de enviar (previne marcação automática)
        try { await this.injectNoRead(); } catch (_) {}
        return result;
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
            
            // BLOQUEIO AGRESSIVO: Garante que o chat não será aberto/marcado como lido
            try { 
                if (this.client && this.started) {
                    await this.injectNoRead(); 
                    // Força o chat a ficar como não lido ANTES de enviar
                    await this.forceChatUnread(chatId);
                }
            } catch (e) {
                // Ignora erros de target closed
                if (e.message && !e.message.includes('Target closed')) {
                    // Só loga outros erros
                }
            }
            
            const result = await sendFn();
            
            // PROTEGE IMEDIATAMENTE após enviar (o WhatsApp pode tentar marcar como lida)
            try { 
                if (this.client && this.started) {
                    // Aguarda um pouco para o WhatsApp processar
                    await new Promise(resolve => setTimeout(resolve, 100));
                    // Força não lido novamente após envio
                    await this.forceChatUnread(chatId);
                    await this.injectNoRead();
                    // Aguarda mais um pouco e força novamente (proteção extra)
                    await new Promise(resolve => setTimeout(resolve, 200));
                    await this.forceChatUnread(chatId);
                }
            } catch (e) {
                // Ignora erros de target closed
                if (e.message && !e.message.includes('Target closed')) {
                    // Só loga outros erros
                }
            }
            
            // Registra mensagem enviada no painel (se texto foi fornecido)
            if (messageText && chatId) {
                try {
                    // Tenta obter o nome do contato para atualizar o chat
                    let contactName = '';
                    try {
                        if (this.client) {
                            const contact = await this.client.getContactById(chatId);
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
                () => this.sendPtt(chatId, audioPath),
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
                    () => this.sendText(chatId, text),
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
                () => this.sendText(chatId, text),
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
                await this.sendKeepingUnread(() => this.sendText(chatId, instructionsMsg), chatId, instructionsMsg);
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
            
            await this.sendKeepingUnread(() => this.sendFile(chatId, imagePath, 'instrucoes_pix.png', caption), chatId, caption);
            
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
                await this.sendKeepingUnread(() => this.sendText(chatId, instructionsMsg), chatId, instructionsMsg);
            } catch (_) {}
        }
    }

    sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

    /**
     * Força um chat específico a ficar como não lido (proteção extra)
     */
    async forceChatUnread(chatId) {
        try {
            // Verifica se o cliente está conectado e se tem página ativa
            if (!this.client || !this.started) return;
            const page = this.client?.page || this.client?.pupPage;
            if (!page || typeof page.evaluate !== 'function') return;
            
            // Verifica se a página está aberta e não fechada
            if (page.isClosed && page.isClosed()) return;
            
            await page.evaluate((chatIdToForce) => {
                try {
                    if (window.Store && window.Store.Chat) {
                        const chat = window.Store.Chat.get(chatIdToForce);
                        if (chat) {
                            // Força o chat a ficar como não lido
                            chat.unreadCount = (chat.unreadCount || 0) + 1;
                            chat.unread = true;
                            chat.readOnly = false;
                            // Remove qualquer flag de leitura
                            if (chat.t) delete chat.t; // timestamp de leitura
                            if (chat.readTimestamp) delete chat.readTimestamp;
                            // Força update no UI
                            if (window.Store.Chat && typeof window.Store.Chat.update === 'function') {
                                try {
                                    window.Store.Chat.update([chat]);
                                } catch {}
                            }
                        }
                    }
                } catch (e) {}
            }, chatId).catch((e) => {
                if (!e || !e.message) return;
                const msg = String(e.message);
                if (
                    msg.includes('Target closed') ||
                    msg.includes('Cannot read properties') ||
                    msg.includes('is not defined')
                ) {
                    return; // ignora erros comuns quando Store ainda não carregou
                }
                throw e;
            });
        } catch (e) {
            // Ignora erros silenciosamente (incluindo target closed)
            if (e.message && !e.message.includes('Target closed')) {
                // Só loga se não for target closed
            }
        }
    }

    // ===== Injeção no WhatsApp Web para bloquear marcação de leitura =====
    async injectNoRead() {
        try {
            // Verifica se o cliente está conectado antes de tentar injetar
            if (!this.client || !this.started) return;
            const page = this.client?.page || this.client?.pupPage;
            if (!page || typeof page.evaluate !== 'function') return;
            
            // Verifica se a página está aberta e não fechada
            if (page.isClosed && page.isClosed()) return;
            
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

                        // BLOQUEIA COMPLETAMENTE abertura/seleção de chats (isso marca como lida automaticamente)
                        if (window.Store.Chat) {
                            // Permite abrir temporariamente para enviar, mas força não lido IMEDIATAMENTE
                            const originalChatOpen = window.Store.Chat.open;
                            if (typeof originalChatOpen === 'function') {
                                window.Store.Chat.open = function(...args) {
                                    const chatId = args[0];
                                    // Permite abrir temporariamente (pode ser necessário para enviar)
                                    const result = originalChatOpen?.apply(this, args);
                                    
                                    // FORÇA NÃO LIDO IMEDIATAMENTE após abrir (SEM DELAY)
                                    if (chatId) {
                                        try {
                                            const chat = window.Store.Chat?.get(chatId);
                                            if (chat) {
                                                // FORÇA não lido ANTES do WhatsApp processar
                                                chat.unreadCount = (chat.unreadCount || 0) + 1;
                                                chat.unread = true;
                                                chat.readOnly = false;
                                                // Remove timestamps de leitura
                                                if (chat.t) chat.t = undefined;
                                                if (chat.readTimestamp) chat.readTimestamp = undefined;
                                                if (chat.unreadStamp) chat.unreadStamp = Date.now();
                                            }
                                        } catch {}
                                    }
                                    
                                    // Força novamente após micro delay (proteção extra)
                                    setTimeout(() => {
                                        try {
                                            if (chatId) {
                                                const chat = window.Store.Chat?.get(chatId);
                                                if (chat) {
                                                    chat.unreadCount = (chat.unreadCount || 0) + 1;
                                                    chat.unread = true;
                                                }
                                            }
                                        } catch {}
                                    }, 50);
                                    
                                    return result;
                                };
                            }
                            
                            // Bloqueia completamente outras formas de abrir
                            ['_open','select', 'setActiveChat', 'setActive'].forEach((fn) => { 
                                if (typeof window.Store.Chat[fn] === 'function') {
                                    window.Store.Chat[fn] = function(...args) {
                                        console.log(`[BLOQUEADO] Chat.${fn} ignorado`);
                                        return Promise.resolve();
                                    };
                                }
                            });
                        }
                        if (window.Store.Cmd) {
                            ['openChatFromUnreadBar','openChatAt','profileSubscribe'].forEach((fn) => { if (typeof window.Store.Cmd[fn] === 'function') window.Store.Cmd[fn] = noop; });
                        }
                        if (window.Store.Conversation) {
                            // Permite abrir mas força não lido IMEDIATAMENTE
                            const originalConvOpen = window.Store.Conversation.open;
                            if (typeof originalConvOpen === 'function') {
                                window.Store.Conversation.open = function(...args) {
                                    const chatId = args[0];
                                    // Permite abrir temporariamente
                                    const result = originalConvOpen?.apply(this, args);
                                    
                                    // FORÇA NÃO LIDO IMEDIATAMENTE após abrir
                                    if (chatId) {
                                        try {
                                            const chat = window.Store.Chat?.get(chatId);
                                            if (chat) {
                                                chat.unreadCount = (chat.unreadCount || 0) + 1;
                                                chat.unread = true;
                                                if (chat.t) chat.t = undefined;
                                                if (chat.readTimestamp) chat.readTimestamp = undefined;
                                            }
                                        } catch {}
                                    }
                                    
                                    // Força novamente após micro delay
                                    setTimeout(() => {
                                        try {
                                            if (chatId) {
                                                const chat = window.Store.Chat?.get(chatId);
                                                if (chat) {
                                                    chat.unreadCount = (chat.unreadCount || 0) + 1;
                                                    chat.unread = true;
                                                }
                                            }
                                        } catch {}
                                    }, 50);
                                    
                                    return result;
                                };
                            }
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
                                // Também bloqueia qualquer comando relacionado a "read" ou "seen"
                                if (/\bread\b|\breadReceipts\b|\bmarkAsRead\b|\bsendSeen\b|\bseen\b|\bpresence\b|\btyping\b|\bcomposing\b|\bstatus\b|\bstory\b|\bstatusweb\b/i.test(payload)) {
                                    return; // drop - NÃO envia comando de leitura
                                }
                            } catch {}
                            return _send.apply(this, arguments);
                        };
                    }
                    
                    // Intercepta TODAS as tentativas de marcar como lida (BLOQUEIO TOTAL)
                    // Bloqueia função de marcar como lida ANTES de qualquer envio
                    if (window.Store && window.Store.Chat) {
                        // Bloqueia a função markAsRead do Chat completamente
                        window.Store.Chat.markAsRead = function(...args) {
                            // NÃO FAZ NADA - bloqueia completamente
                            console.log('[BLOQUEADO] Tentativa de marcar chat como lido ignorada');
                            // Força não lido se houver chatId
                            try {
                                const chatId = args[0];
                                if (chatId) {
                                    const chat = window.Store.Chat?.get(chatId);
                                    if (chat) {
                                        chat.unreadCount = (chat.unreadCount || 0) + 1;
                                        chat.unread = true;
                                    }
                                }
                            } catch {}
                            return Promise.resolve();
                        };
                        
                        // Bloqueia também a função que pode ser chamada ao enviar mensagem
                        if (window.Store.Chat.updateRead) {
                            window.Store.Chat.updateRead = function(...args) {
                                console.log('[BLOQUEADO] Tentativa de updateRead ignorada');
                                // Força não lido se houver chatId
                                try {
                                    const chatId = args[0];
                                    if (chatId) {
                                        const chat = window.Store.Chat?.get(chatId);
                                        if (chat) {
                                            chat.unreadCount = (chat.unreadCount || 0) + 1;
                                            chat.unread = true;
                                        }
                                    }
                                } catch {}
                                return Promise.resolve();
                            };
                        }
                        
                        // Bloqueia também markRead se existir
                        if (window.Store.Chat.markRead) {
                            window.Store.Chat.markRead = function(...args) {
                                console.log('[BLOQUEADO] Tentativa de markRead ignorada');
                                try {
                                    const chatId = args[0];
                                    if (chatId) {
                                        const chat = window.Store.Chat?.get(chatId);
                                        if (chat) {
                                            chat.unreadCount = (chat.unreadCount || 0) + 1;
                                            chat.unread = true;
                                        }
                                    }
                                } catch {}
                                return Promise.resolve();
                            };
                        }
                    }
                    
                    // Intercepta chamadas de mensagem enviada para prevenir marcação como lida
                    if (window.Store && window.Store.Msg) {
                        const originalMsgSend = window.Store.Msg.send;
                        if (typeof originalMsgSend === 'function') {
                            window.Store.Msg.send = function(...args) {
                                // BLOQUEIA qualquer tentativa de marcar como lida ANTES de enviar
                                const chatId = args[0]?.to || args[0]?.id?.remote || args[0]?.chatId;
                                if (chatId) {
                                    try {
                                        const chat = window.Store.Chat?.get(chatId);
                                        if (chat) {
                                            // Força não lido ANTES de enviar
                                            chat.unreadCount = (chat.unreadCount || 0) + 1;
                                            chat.unread = true;
                                        }
                                    } catch {}
                                }
                                
                                const result = originalMsgSend.apply(this, args);
                                
                                // Após enviar mensagem, força não lida no chat NOVAMENTE
                                setTimeout(() => {
                                    try {
                                        if (chatId) {
                                            const chat = window.Store.Chat?.get(chatId);
                                            if (chat) {
                                                chat.unreadCount = (chat.unreadCount || 0) + 1;
                                                chat.unread = true;
                                                // Remove qualquer timestamp de leitura
                                                if (chat.t) chat.t = undefined;
                                                if (chat.readTimestamp) chat.readTimestamp = undefined;
                                            }
                                        }
                                    } catch {}
                                }, 100);
                                
                                // Força novamente após mais tempo
                                setTimeout(() => {
                                    try {
                                        if (chatId) {
                                            const chat = window.Store.Chat?.get(chatId);
                                            if (chat) {
                                                chat.unreadCount = (chat.unreadCount || 0) + 1;
                                                chat.unread = true;
                                            }
                                        }
                                    } catch {}
                                }, 500);
                                
                                return result;
                            };
                        }
                    }
                    
                    // BLOQUEIA completamente a função sendSeen em TODOS os lugares
                    if (window.Store) {
                        // Bloqueia em todos os objetos Store que podem ter sendSeen
                        ['Msg', 'Message', 'Chat', 'Conversation', 'MessageInfo', 'MsgInfo'].forEach((storeName) => {
                            if (window.Store[storeName]) {
                                const obj = window.Store[storeName];
                                if (typeof obj.sendSeen === 'function') {
                                    obj.sendSeen = function(...args) {
                                        console.log(`[BLOQUEADO] sendSeen em ${storeName} ignorado`);
                                        return Promise.resolve();
                                    };
                                }
                                if (typeof obj.markAsRead === 'function') {
                                    obj.markAsRead = function(...args) {
                                        console.log(`[BLOQUEADO] markAsRead em ${storeName} ignorado`);
                                        return Promise.resolve();
                                    };
                                }
                            }
                        });
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
            }).catch((e) => {
                if (!e || !e.message) return;
                const msg = String(e.message);
                if (
                    msg.includes('Target closed') ||
                    msg.includes('Cannot read properties') ||
                    msg.includes('is not defined')
                ) {
                    return;
                }
                throw e;
            });
        } catch (e) {
            if (e.message && !e.message.includes('Target closed') && !e.message.includes('Target closed')) {
            }
        }
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
                    if (this.client) {
                        const contact = await this.client.getContactById(chatId);
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
                    () => this.sendText(chatId, text),
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
                console.log(`[sendAudio] Tentando enviar PTT para ${chatId} usando ${audioPath}`);
                // Tenta sendPtt primeiro (PTT = Push to Talk, formato recomendado)
                result = await this.sendPtt(chatId, audioPath);
                console.log('[sendAudio] Envio PTT concluído com sucesso');
            } catch (pttError) {
                console.error('[sendAudio] Falha ao enviar PTT, caindo para sendFile:', pttError);
                try {
                    // Tenta sendFile como fallback
                result = await this.sendFile(chatId, audioPath, fileName, '');
                    console.log('[sendAudio] Envio via sendFile concluído');
                } catch (fileError) {
                    throw new Error('Erro ao enviar áudio: ' + fileError.message);
                }
            }

        if (result && result.id) {
            result.id = this.normalizeMessageId(result.id);
        }

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

    normalizeMessageId(messageId) {
        if (!messageId) return null;
        if (typeof messageId === 'string') return messageId;
        if (typeof messageId === 'object') {
            if (messageId._serialized) return messageId._serialized;
            if (messageId.id) return this.normalizeMessageId(messageId.id);
        }
        try {
            return String(messageId);
        } catch {
            return null;
        }
    }

    /**
     * Encerra o bot e fecha a sessão com segurança.
     */
    /**
     * Reconecta o websocket se estiver desconectado
     */
    async reconnect() {
        try {
            console.log('🔄 Verificando conexão do websocket...');
            
            // Verifica se o cliente existe e está conectado
            if (this.client) {
                try {
                    const state = await this.client.getState();
                    if (state === 'CONNECTED') {
                        console.log('✅ Websocket já está conectado');
                        return { success: true, message: 'Já conectado', reconnected: false };
                    }
                } catch (e) {
                    console.log('⚠️ Erro ao verificar conexão:', e.message);
                }
            }
            
            console.log('🔌 Websocket desconectado. Reconectando...');
            
            // Para o cliente atual se existir
            const wasStarted = this.started;
            if (this.client || wasStarted) {
                try {
                    // Reseta a flag para permitir reiniciar
                    this.started = false;
                    await this.stop();
                } catch (e) {
                    console.log('⚠️ Erro ao parar cliente:', e.message);
                    // Força reset da flag mesmo se der erro
                    this.started = false;
                }
            }
            
            // Aguarda um pouco antes de reconectar
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Reinicia o cliente
            await this.start();
            
            // Aguarda um pouco para garantir que conectou
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Verifica novamente se está conectado
            if (this.client) {
                try {
                    const state = await this.client.getState();
                    if (state === 'CONNECTED') {
                        console.log('✅ Websocket reconectado com sucesso!');
                        return { success: true, message: 'Reconectado com sucesso', reconnected: true };
                    }
                } catch (e) {
                    console.log('⚠️ Erro ao verificar reconexão:', e.message);
                }
            }
            
            return { success: false, message: 'Falha ao reconectar', reconnected: false };
        } catch (e) {
            console.error('❌ Erro ao reconectar websocket:', e);
            // Garante que a flag seja resetada em caso de erro
            this.started = false;
            return { success: false, message: e.message || 'Erro desconhecido', reconnected: false };
        }
    }

    /**
     * Pausa o websocket (para o cliente)
     */
    async pause() {
        try {
            console.log('⏸️ Pausando websocket...');
            if (this.client) {
                await this.stop();
                console.log('✅ Websocket pausado');
                return { success: true, message: 'Websocket pausado' };
            }
            return { success: false, message: 'Cliente não está conectado' };
        } catch (e) {
            console.error('❌ Erro ao pausar websocket:', e);
            return { success: false, message: e.message || 'Erro desconhecido' };
        }
    }

    /**
     * Retoma o websocket (reinicia o cliente)
     */
    async resume() {
        try {
            console.log('▶️ Retomando websocket...');
            if (!this.started) {
                await this.start();
                console.log('✅ Websocket retomado');
                return { success: true, message: 'Websocket retomado' };
            }
            return { success: false, message: 'Cliente já está ativo' };
        } catch (e) {
            console.error('❌ Erro ao retomar websocket:', e);
            return { success: false, message: e.message || 'Erro desconhecido' };
        }
    }

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
            if (this.zombieWatchdog) {
                clearInterval(this.zombieWatchdog);
                this.zombieWatchdog = null;
            }
            if (this.client) {
                // Destrói o cliente (fecha navegador e limpa recursos)
                await this.client.destroy();
                console.log('🛑 Bot parado (whatsapp-web.js).');
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
            const contact = await this.client.getContactById(chatId);
            const profilePicUrl = await contact.getProfilePicUrl();
            return profilePicUrl || null;
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


