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
        this.initialized = false; // Indica se o bot foi inicializado (mesmo que tenha erro depois)
        this.qrString = null;
        this.authState = null; // Estado de autenticação para verificar credenciais
        // Logger COMPLETAMENTE silencioso - desativa TODOS os logs do Baileys
        // Isso é crítico para evitar logs enormes de criptografia que enchem o heap
        // Níveis: trace, debug, info, warn, error, fatal, silent
        // 'silent' desabilita completamente TODOS os logs
        const logLevel = process.env.BAILEYS_LOG_LEVEL || 'silent';
        this.logger = P({
            level: logLevel === 'silent' ? 'silent' : logLevel,
            // Desativa timestamp para reduzir overhead
            timestamp: false,
            // Reduz ao mínimo possível
            serializers: {},
            // Não escreve em arquivo
            transport: undefined
        });
        
        // Garante que mesmo se houver algum log, não vai para stdout/stderr
        if (logLevel === 'silent') {
            // Cria logger que não escreve nada
            this.logger = {
                trace: () => {},
                debug: () => {},
                info: () => {},
                warn: () => {},
                error: () => {},
                fatal: () => {},
                child: () => this.logger,
                level: 'silent'
            };
        }
        
        // Intercepta stderr para capturar erros Bad MAC do libsignal que não são capturados pelos handlers
        // Isso é necessário porque o libsignal escreve diretamente no stderr
        // Também filtra mensagens normais que não são erros reais
        this.originalStderrWrite = process.stderr.write.bind(process.stderr);
        this.stderrFilterCount = 0; // Contador para reduzir spam de logs
        this.lastStderrLogTime = 0; // Timestamp do último log filtrado
        const self = this;
        process.stderr.write = function(chunk, encoding, fd) {
            const message = chunk ? chunk.toString() : '';
            
            // Filtra mensagens normais do libsignal que não são erros
            const normalMessages = [
                'Closing open session',
                'Closing stale open session',
                'in favor of incoming prekey bundle',
                'for new outgoing prekey bundle'
            ];
            
            const isNormalMessage = normalMessages.some(normal => message.includes(normal));
            
            // Se for mensagem normal, não escreve no stderr (reduz spam)
            if (isNormalMessage) {
                return true; // Retorna true para indicar que foi "escrito" mas não escreve nada
            }
            
            // Trata erros Bad MAC reais
            if (message.includes('Bad MAC') || message.includes('Session error')) {
                // Cria um erro simulado para usar o handler existente
                const error = new Error(message.trim().substring(0, 200)); // Limita tamanho
                // Usa setImmediate para evitar problemas de timing e não bloquear
                setImmediate(() => {
                    try {
                        if (self && typeof self.handleBadMacError === 'function') {
                            self.handleBadMacError('do libsignal (stderr)', error);
                        }
                    } catch (e) {
                        // Ignora erros no handler para não causar loop
                    }
                });
                
                // Reduz verbosidade: só escreve no stderr se for erro crítico ou a cada 10 erros
                const now = Date.now();
                self.stderrFilterCount = (self.stderrFilterCount || 0) + 1;
                if (self.stderrFilterCount % 10 === 0 || now - (self.lastStderrLogTime || 0) > 60000) {
                    self.lastStderrLogTime = now;
                    return self.originalStderrWrite(chunk, encoding, fd);
                }
                return true; // Não escreve no stderr para reduzir spam
            }
            
            // Sempre chama o write original para outros tipos de mensagens
            return self.originalStderrWrite(chunk, encoding, fd);
        };
        
        // Diretório de autenticação único por instância
        // Usa variável de ambiente BAILEYS_SESSION_ID ou porta como identificador
        // IMPORTANTE: process.env.PORT pode ser string, precisa converter
        const sessionId = process.env.BAILEYS_SESSION_ID || 
                         (process.env.PORT ? String(process.env.PORT) : null) || 
                         'baileys1';
        this.authDir = path.join(__dirname, `tokens-${sessionId}`);
        this.port = process.env.PORT ? parseInt(process.env.PORT) : 3009; // Porta do servidor para logs
        console.log(`📁 Diretório de autenticação: ${this.authDir}`);
        console.log(`🌐 Porta configurada: ${this.port}`);
        console.log(`🔑 Session ID usado: ${sessionId}`);
        console.log(`⚠️ IMPORTANTE: Certifique-se de que cada bot usa um diretório diferente!`);
        this.reconnectRequested = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5; // Limite de tentativas antes de limpar sessão
        this.lastDisconnectTime = 0; // Timestamp da última desconexão
        this.lastConnectTime = 0; // Timestamp da última conexão bem-sucedida
        this.disconnectCount = 0; // Contador de desconexões consecutivas
        this.keepAliveInterval = null; // Interval do keepalive
        this.isRestarting = false; // Flag para evitar múltiplas tentativas de restart simultâneas
        this.restartTimeout = null; // Timeout do restart para poder cancelar
        this.lastConnectionError = null; // Último erro de conexão para debug
        this.conversationContext = new Map();
        this.userStates = new Map(); // guarda último contexto por usuário (clientId, serviceId, billId)
        this.lastResponseTime = new Map(); // rate limiting por chat
        this.processedMessages = new Map(); // evita processar mensagens duplicadas
        
        // Contadores para erros Bad MAC (sessão corrompida)
        this.badMacErrorCount = 0; // Contador de erros Bad MAC consecutivos
        this.badMacErrorThreshold = 5; // Limite de erros antes de limpar sessão (reduzido para acionar mais rápido)
        this.lastBadMacErrorTime = 0; // Timestamp do último erro Bad MAC
        this.badMacErrorWindow = 3 * 60 * 1000; // Janela de 3 minutos para contar erros (reduzida)
        this.lastBadMacLogTime = 0; // Timestamp do último log detalhado de Bad MAC
        
        
        // Tratamento global de erros não capturados - GARANTE que o bot nunca pare
        process.on('uncaughtException', (err) => {
            const errorMsg = err?.message || err?.toString() || '';
            // Se for erro Bad MAC, trata mas não para o bot
            if (errorMsg.includes('Bad MAC') || 
                errorMsg.includes('verifyMAC') || 
                errorMsg.includes('decryptWithSessions') ||
                errorMsg.includes('Session error')) {
                console.error('⚠️ Erro Bad MAC não capturado (continuando):', errorMsg.substring(0, 200));
                if (typeof this.handleBadMacError === 'function') {
                    try {
                        this.handleBadMacError('erro não capturado', err);
                    } catch (e) {
                        // Ignora erros no handler
                    }
                }
                return; // NÃO re-lança o erro
            }
            // Para outros erros críticos, loga mas não para o bot
            console.error('⚠️ Erro não capturado (bot continua funcionando):', errorMsg.substring(0, 200));
        });
        
        process.on('unhandledRejection', (reason, promise) => {
            const errorMsg = reason?.message || reason?.toString() || '';
            // Se for erro Bad MAC, trata mas não para o bot
            if (errorMsg.includes('Bad MAC') || 
                errorMsg.includes('verifyMAC') || 
                errorMsg.includes('decryptWithSessions') ||
                errorMsg.includes('Session error')) {
                console.error('⚠️ Promise rejeitada Bad MAC (continuando):', errorMsg.substring(0, 200));
                if (typeof this.handleBadMacError === 'function') {
                    try {
                        this.handleBadMacError('promise rejeitada', reason);
                    } catch (e) {
                        // Ignora erros no handler
                    }
                }
                return; // NÃO re-lança o erro
            }
            // Para outros erros, loga mas não para o bot
            console.error('⚠️ Promise rejeitada (bot continua funcionando):', errorMsg.substring(0, 200));
        });
        
        // Limpeza automática de contexto a cada 30 minutos (não muito agressiva)
        setInterval(() => {
            try {
                this.cleanupOldContexts();
            } catch (e) {
                // Ignora erros na limpeza
            }
        }, 30 * 60 * 1000);
        // Limpeza automática de userStates a cada 1 hora
        setInterval(() => {
            try {
                this.cleanupOldUserStates();
            } catch (e) {
                // Ignora erros na limpeza
            }
        }, 60 * 60 * 1000);
        // Limpeza automática de rate limiting a cada 10 minutos
        setInterval(() => {
            try {
                this.cleanupRateLimiting();
            } catch (e) {
                // Ignora erros na limpeza
            }
        }, 10 * 60 * 1000);
        // Limpeza periódica de sessões antigas a cada 6 horas
        setInterval(() => {
            try {
                this.cleanupOldSessions();
            } catch (e) {
                // Ignora erros na limpeza
            }
        }, 6 * 60 * 60 * 1000);
    }

    setPort(port) {
        this.port = port;
        console.log(`🌐 Porta atualizada para: ${this.port}`);
    }

    async start() {
        if (this.started) {
            console.log('⚠️ Baileys já iniciado.');
            return;
        }
        
        if (this.isRestarting) {
            console.log('⚠️ Baileys já está reiniciando. Aguarde...');
            return;
        }

        if (!fs.existsSync(this.authDir)) {
            fs.mkdirSync(this.authDir, { recursive: true });
        }

        // Aguarda antes de iniciar para evitar rate limiting (sempre aguarda na primeira vez também)
        const baseWaitTime = 3000; // 3 segundos base
        const reconnectWaitTime = this.reconnectAttempts > 0 ? Math.min(5000 * this.reconnectAttempts, 30000) : 0;
        const totalWaitTime = baseWaitTime + reconnectWaitTime;
        
        if (totalWaitTime > 0) {
            console.log(`⏳ Aguardando ${totalWaitTime/1000}s antes de iniciar conexão (evita erro 405)...`);
            await new Promise(resolve => setTimeout(resolve, totalWaitTime));
        }

        console.log('📡 Carregando estado de autenticação...');
        const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
        this.saveCreds = saveCreds;
        this.authState = state; // Salva state para verificar depois
        
        console.log('📦 Buscando versão mais recente do Baileys...');
        const { version } = await fetchLatestBaileysVersion();
        console.log(`✅ Versão Baileys: ${version.join('.')}`);

        // Verifica se há credenciais salvas
        const hasCredentials = state.creds && state.creds.me;
        console.log(`🔐 Estado de autenticação: ${hasCredentials ? 'Credenciais encontradas' : 'Sem credenciais (precisa escanear QR)'}`);
        if (hasCredentials) {
            console.log(`📱 Conectado como: ${state.creds.me?.id || 'N/A'}`);
            // Verifica se credenciais estão válidas
            if (!state.creds.registered || !state.creds.account) {
                console.log('⚠️ Credenciais podem estar inválidas ou incompletas');
            }
        }

        // Configuração otimizada para evitar erro 405
        // Aumenta delays e timeouts para evitar rate limiting
        this.sock = makeWASocket({
            version,
            auth: state,
            logger: this.logger,
            browser: Browsers.macOS('Chrome'),
            markOnlineOnConnect: false, // Mudado para false para evitar detecção
            syncFullHistory: false,
            emitOwnEvents: false,
            generateHighQualityLinkPreview: false,
            // printQRInTerminal foi removido (deprecated) - estamos imprimindo manualmente
            // Timeouts maiores para evitar desconexões e erro 405
            connectTimeoutMs: 180000, // 3 minutos (aumentado)
            defaultQueryTimeoutMs: 180000, // 3 minutos (aumentado)
            keepAliveIntervalMs: 30000, // Keepalive a cada 30 segundos (menos frequente para evitar detecção)
            qrTimeout: 180000, // 3 minutos
            // Configurações para manter conexão
            shouldSyncHistoryMessage: () => false,
            shouldIgnoreJid: () => false,
            // Delays maiores para evitar rate limiting
            retryRequestDelayMs: 1000, // Aumentado de 250 para 1000ms
            maxMsgRetryCount: 2, // Reduzido para evitar muitas tentativas
            // Configurações de conexão
            getMessage: async (key) => {
                return undefined; // Não busca mensagens antigas
            },
            // Configurações adicionais para evitar erro 405
            fireInitQueries: false // Não dispara queries automáticas na inicialização
        });

        this.client = this.sock;
        
        console.log('🔌 Socket Baileys criado. Configurando listeners...');
        
        // Marca como não reiniciando quando conecta com sucesso
        this.isRestarting = false;
        if (this.restartTimeout) {
            clearTimeout(this.restartTimeout);
            this.restartTimeout = null;
        }

        // Listener único para connection.update (evita duplicação)
        this.sock.ev.on('connection.update', (update) => {
            if (update.connection === 'connecting') {
                console.log('🔄 Tentando conectar...');
            } else if (update.connection === 'open') {
                console.log('✅ Conexão estabelecida com sucesso!');
            } else if (update.connection === 'close') {
                console.log('❌ Conexão fechada');
            }
            
            // Processa atualização através do handler principal
            this.handleConnectionUpdate(update).catch(err => console.error('❌ ERRO conexão Baileys:', err));
        });
        
        // Log adicional para verificar se eventos estão sendo registrados
        console.log('📡 Event listeners registrados. Aguardando eventos de conexão...');

        // Salva credenciais sempre que atualizar (silenciosamente)
        this.sock.ev.on('creds.update', () => {
            // Log removido para reduzir verbosidade - credenciais são salvas automaticamente
            saveCreds();
        });

        this.sock.ev.on('messages.upsert', (payload) => {
            this.handleMessagesUpsert(payload).catch(err => {
                // Trata TODOS os erros sem deixar parar o bot
                const errorMsg = err?.message || err?.toString() || '';
                if (errorMsg.includes('Bad MAC') || 
                    errorMsg.includes('Failed to decrypt') || 
                    errorMsg.includes('Session error') ||
                    errorMsg.includes('verifyMAC') ||
                    errorMsg.includes('decryptWithSessions')) {
                    // Trata erro Bad MAC mas continua funcionando
                    this.handleBadMacError('ao processar mensagem', err);
                } else {
                    // Para outros erros, apenas loga mas não para o bot
                    console.error('⚠️ Erro ao processar mensagens (continuando):', errorMsg.substring(0, 200));
                }
                // NUNCA re-lança o erro para não parar o bot
            });
        });

        // Listener para erros de descriptografia (Bad MAC)
        // IMPORTANTE: NUNCA deixa erros pararem o bot
        this.sock.ev.on('error', (err) => {
            const errorMsg = err?.message || err?.toString() || '';
            if (errorMsg.includes('Bad MAC') || 
                errorMsg.includes('Failed to decrypt') || 
                errorMsg.includes('Session error') ||
                errorMsg.includes('verifyMAC') ||
                errorMsg.includes('decryptWithSessions')) {
                // Trata erro Bad MAC mas continua funcionando
                this.handleBadMacError('no socket', err);
            } else {
                // Para outros erros, apenas loga mas não para o bot
                console.error('⚠️ Erro no socket Baileys (continuando):', errorMsg.substring(0, 200));
            }
            // NUNCA re-lança o erro - o bot deve continuar funcionando sempre
        });

        this.started = true;
        this.initialized = true; // Marca como inicializado
        console.log('✅ Bot Baileys inicializado.');
        console.log('⏳ Aguardando eventos de conexão do WhatsApp...');
        console.log('💡 O QR code aparecerá aqui quando o WhatsApp solicitar.');
        console.log('');
        
        // Timeout para verificar se eventos estão sendo recebidos
        setTimeout(() => {
            if (!this.qrString && !this.sock?.user) {
                console.log('⚠️ [DEBUG] Após 5 segundos: Nenhum evento de conexão recebido ainda.');
                console.log('⚠️ [DEBUG] Socket existe?', !!this.sock);
                console.log('⚠️ [DEBUG] Socket tem eventos?', !!this.sock?.ev);
                console.log('💡 Isso é normal se não houver credenciais salvas. Aguarde mais alguns segundos...');
            }
        }, 5000);
    }

    async handleConnectionUpdate(update) {
        const { connection, lastDisconnect, qr } = update;
        
        // Log detalhado quando há QR
        if (qr) {
            console.log(`🔍 [DEBUG] QR recebido! Tamanho: ${qr.length} caracteres`);
            this.qrString = qr;
            console.log('');
            console.log('═══════════════════════════════════════════════════════');
            console.log('📱 QR CODE GERADO - ESCANEIE COM SEU WHATSAPP');
            console.log('═══════════════════════════════════════════════════════');
            console.log('');
            
            // Imprime QR code no terminal usando qrcode-terminal
            try {
                const qrcodeTerminal = require('qrcode-terminal');
                console.log('🖨️ Imprimindo QR code no terminal...');
                qrcodeTerminal.generate(qr, { small: true });
                console.log('✅ QR code impresso no terminal!');
            } catch (e) {
                console.log('⚠️ Erro ao gerar QR no terminal:', e.message);
                console.log('💡 Stack:', e.stack);
            }
            
            console.log('');
            console.log('═══════════════════════════════════════════════════════');
            console.log(`📱 Ou acesse: http://localhost:${this.port}/api/session/qr`);
            console.log(`📊 Status: http://localhost:${this.port}/api/session/status`);
            console.log('═══════════════════════════════════════════════════════');
            console.log('');
            console.log('⏳ Aguardando escaneamento do QR code...');
            console.log('');
            this.reconnectAttempts = 0; // Reset contador quando QR é gerado
        }

        if (connection === 'open') {
            console.log('');
            console.log('═══════════════════════════════════════════════════════');
            console.log('🤝 BAILEYS CONECTADO COM SUCESSO!');
            console.log('═══════════════════════════════════════════════════════');
            this.qrString = null; // Limpa QR quando conecta
            
            // Reseta contadores quando conecta com sucesso
            this.reconnectAttempts = 0;
            this.disconnectCount = 0;
            this.lastConnectTime = Date.now();
            this.isRestarting = false; // Reseta flag de restart quando conecta
            this.lastConnectionError = null; // Limpa erro quando conecta
            if (this.restartTimeout) {
                clearTimeout(this.restartTimeout);
                this.restartTimeout = null;
            }
            
            // Verifica se socket está realmente conectado
            if (this.sock?.user) {
                const userId = this.sock.user.id;
                const phoneNumber = userId.split(':')[0];
                console.log(`✅ Sessão ativa: ${userId}`);
                console.log(`📱 Número conectado: ${phoneNumber}`);
                console.log(`🌐 Servidor rodando em: http://localhost:${this.port}`);
                console.log(`📊 Painel disponível em: http://localhost:${this.port}`);
                console.log(`📁 Diretório de tokens: ${this.authDir}`);
                console.log('═══════════════════════════════════════════════════════');
                console.log('');
            } else {
                console.log('⚠️ Socket conectado mas sem informações do usuário');
            }
            
            // Inicia keepalive manual para garantir conexão
            this.startKeepAlive();
        } else if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const errorMessage = lastDisconnect?.error?.message || 'Sem mensagem de erro';
            console.log('⚠️ Baileys desconectado:', statusCode);
            console.log(`📋 Detalhes da desconexão: ${errorMessage}`);
            if (lastDisconnect?.error) {
                console.log(`🔍 Erro completo:`, JSON.stringify(lastDisconnect.error, null, 2));
            }
            this.started = false;
            this.lastConnectionError = statusCode; // Salva último erro para debug

            // VERIFICA CÓDIGO 428 PRIMEIRO - Connection Terminated by Server (múltiplas instâncias)
            const isCode428 = (statusCode === 428);
            
            if (isCode428) {
                console.log(`⚠️ Código 428 detectado: CONEXÃO TERMINADA PELO SERVIDOR`);
                console.log(`💡 Isso geralmente significa:`);
                console.log(`   - Múltiplas instâncias estão usando a mesma sessão`);
                console.log(`   - Outro bot está conectado com o mesmo número`);
                console.log(`   - Sessão está sendo usada em outro lugar`);
                console.log(`\n📁 Diretório de autenticação atual: ${this.authDir}`);
                console.log(`💡 SOLUÇÃO:`);
                console.log(`   1. Pare TODOS os bots (Ctrl+C em todos os terminais)`);
                console.log(`   2. Certifique-se de que cada bot usa um diretório diferente`);
                console.log(`   3. Use: npm run start:bot1, npm run start:bot2, npm run start:bot3`);
                console.log(`   4. Ou configure PORT diferente: PORT=3009 npm run start:baileys`);
                console.log(`\n⛔ PARANDO RECONEXÃO AUTOMÁTICA para evitar loops!`);
                console.log(`   Reinicie manualmente após resolver o conflito.`);
                
                // Cancela restart anterior se existir
                if (this.restartTimeout) {
                    clearTimeout(this.restartTimeout);
                    this.restartTimeout = null;
                }
                
                // Fecha socket anterior se existir
                try {
                    if (this.sock) {
                        this.sock.end();
                        this.sock = null;
                    }
                } catch (e) {
                    // Ignora erros ao fechar socket
                }
                
                // Para keepalive
                if (this.keepAliveInterval) {
                    clearInterval(this.keepAliveInterval);
                    this.keepAliveInterval = null;
                }
                
                // NÃO tenta reconectar automaticamente quando há conflito de sessão
                this.pauseRequested = true;
                
                return;
            }
            
            // VERIFICA CÓDIGO 440 PRIMEIRO - ANTES DE QUALQUER OUTRA COISA
            const isCode440 = (statusCode === 440);
            
            // Verifica se é erro de conflito (sessão substituída)
            const isConflictReplaced = (
                isCode440 && 
                lastDisconnect?.error?.data?.content?.some?.(
                    item => item?.tag === 'conflict' && item?.attrs?.type === 'replaced'
                )
            );
            
            if (isCode440) {
                if (isConflictReplaced) {
                    console.log(`⚠️ Código 440 detectado: SESSÃO SUBSTITUÍDA (conflict/replaced)`);
                    console.log(`💡 Isso significa que:`);
                    console.log(`   - WhatsApp foi aberto em outro dispositivo`);
                    console.log(`   - Ou outra instância do bot está usando a mesma sessão`);
                    console.log(`   - A sessão atual foi substituída por outra conexão`);
                    console.log(`\n📁 Diretório de autenticação atual: ${this.authDir}`);
                    console.log(`\n⚠️ ATENÇÃO: Não limpará tokens automaticamente para evitar loops!`);
                    console.log(`💡 SOLUÇÃO MANUAL:`);
                    console.log(`   1. Verifique se há outro bot rodando na VPS ou localmente`);
                    console.log(`   2. Certifique-se de que cada bot usa um diretório diferente`);
                    console.log(`   3. Se necessário, limpe tokens manualmente: Remove-Item -Recurse -Force "${this.authDir}"`);
                    console.log(`   4. Reinicie o bot após limpar tokens`);
                    
                    // Cancela restart anterior se existir
                    if (this.restartTimeout) {
                        clearTimeout(this.restartTimeout);
                        this.restartTimeout = null;
                    }
                    
                    // Evita múltiplas tentativas simultâneas
                    if (this.isRestarting) {
                        console.log('⚠️ Já existe um restart em andamento. Aguardando...');
                        return;
                    }
                    
                    // Fecha socket anterior se existir
                    try {
                        if (this.sock) {
                            this.sock.end();
                            this.sock = null;
                        }
                    } catch (e) {
                        // Ignora erros ao fechar socket
                    }
                    
                    // NÃO limpa tokens automaticamente - deixa para o usuário decidir
                    // this.cleanupAuthDir(); // COMENTADO para evitar loops
                    
                    this.reconnectAttempts = 0;
                    this.disconnectCount = 0;
                    this.lastDisconnectTime = 0;
                    this.lastConnectTime = 0;
                    
                    // Para keepalive
                    if (this.keepAliveInterval) {
                        clearInterval(this.keepAliveInterval);
                        this.keepAliveInterval = null;
                    }
                    
                    // Marca como pausado para não tentar reconectar automaticamente
                    this.pauseRequested = true;
                    
                    console.log(`\n⛔ Bot pausado. Para reconectar:`);
                    console.log(`   1. Resolva o conflito de sessão`);
                    console.log(`   2. Limpe tokens se necessário`);
                    console.log(`   3. Reinicie o bot manualmente`);
                    
                    return;
                } else {
                    console.log(`⚠️ Código 440 detectado (sessão fechada temporariamente).`);
                    console.log(`💡 Possíveis causas:`);
                    console.log(`   - Tokens inválidos ou expirados`);
                    console.log(`   - Problema de rede/conexão`);
                    console.log(`   - WhatsApp detectou atividade suspeita`);
                    
                    // Para código 440 genérico, PARA COMPLETAMENTE
                    console.log(`⛔ PARANDO COMPLETAMENTE. Não tentará reconectar automaticamente.`);
                    console.log(`💡 Para reconectar:`);
                    console.log(`   1. Limpe tokens: rm -rf ${this.authDir}`);
                    console.log(`   2. Reinicie o bot`);
                    console.log(`   3. Escaneie novo QR code`);
                    
                    // Para keepalive se estiver rodando
                    if (this.keepAliveInterval) {
                        clearInterval(this.keepAliveInterval);
                        this.keepAliveInterval = null;
                    }
                    
                    // Marca como pausado para não tentar reconectar
                    this.pauseRequested = true;
                    
                    return; // Para completamente, não tenta reconectar
                }
            }

            const now = Date.now();
            const timeSinceLastDisconnect = now - (this.lastDisconnectTime || 0);
            const timeSinceLastConnect = now - (this.lastConnectTime || 0);
            
            // Se desconectou muito rápido após conectar (menos de 30 segundos), incrementa contador
            if (timeSinceLastConnect < 30000 && this.lastConnectTime > 0) {
                this.disconnectCount++;
                console.log(`⚠️ Desconexão rápida após conectar (${Math.round(timeSinceLastConnect/1000)}s). Contador: ${this.disconnectCount}/3`);
            } else if (timeSinceLastDisconnect > 60000) {
                // Se passou mais de 1 minuto desde última desconexão, reseta contador
                this.disconnectCount = 1;
            } else {
                // Incrementa contador se desconexões estão próximas
                this.disconnectCount++;
            }
            this.lastDisconnectTime = now;

            // Códigos que indicam sessão completamente inválida (precisa limpar tokens)
            const mustCleanSession = (
                statusCode === DisconnectReason.loggedOut ||
                statusCode === DisconnectReason.badSession
            );

            if (mustCleanSession) {
                console.log('🧹 Sessão Baileys inválida (código:', statusCode, '). Limpando tokens para gerar novo QR.');
                this.cleanupAuthDir();
                this.reconnectAttempts = 0;
                this.disconnectCount = 0;
                this.lastDisconnectTime = 0;
                this.lastConnectTime = 0;
                return;
            }

            // Verifica erro 405 (Connection Failure) - geralmente indica problema com versão do Baileys ou bloqueio temporário
            const isCode405 = (statusCode === 405);
            
            if (isCode405) {
                console.log(`\n${'='.repeat(60)}`);
                console.log(`⚠️ ERRO 405 DETECTADO: CONNECTION FAILURE`);
                console.log(`${'='.repeat(60)}`);
                console.log(`💡 Isso geralmente significa:`);
                console.log(`   - WhatsApp bloqueou temporariamente a conexão`);
                console.log(`   - Rate limiting do WhatsApp (muitas tentativas)`);
                console.log(`   - Problema temporário nos servidores do WhatsApp`);
                console.log(`   - Versão do Baileys pode estar desatualizada`);
                console.log(`   - Credenciais antigas/inválidas podem estar causando o problema`);
                
                // Se não há credenciais válidas, limpa tokens automaticamente na primeira tentativa
                const hasValidCredentials = this.sock?.user || (this.authState?.creds?.me && this.authState?.creds?.registered);
                if (!hasValidCredentials && this.reconnectAttempts === 0) {
                    console.log(`\n🧹 Sem credenciais válidas detectadas. Limpando tokens para forçar novo QR...`);
                    try {
                        this.cleanupAuthDir();
                        this.authState = null; // Limpa referência
                        console.log(`✅ Tokens limpos. Próxima tentativa gerará novo QR code.`);
                    } catch (e) {
                        console.log(`⚠️ Erro ao limpar tokens:`, e.message);
                    }
                }
                
                console.log(`\n${'='.repeat(60)}`);
                console.log(`⛔ PARANDO RECONEXÃO AUTOMÁTICA PARA EVITAR LOOP!`);
                console.log(`${'='.repeat(60)}`);
                console.log(`\n💡 SOLUÇÕES:`);
                console.log(`\n📋 OPÇÃO 1 - Aguardar e tentar novamente:`);
                console.log(`   1. Pare o bot completamente (Ctrl+C)`);
                console.log(`   2. AGUARDE 2-4 HORAS antes de tentar novamente`);
                console.log(`   3. Limpe tokens: Remove-Item -Recurse -Force "${this.authDir}"`);
                console.log(`   4. Reinicie o bot`);
                console.log(`\n📋 OPÇÃO 2 - Usar whatsapp-web.js temporariamente:`);
                console.log(`   1. Pare o bot (Ctrl+C)`);
                console.log(`   2. Execute: npm start`);
                console.log(`   3. Isso usa whatsapp-web.js em vez de Baileys`);
                console.log(`   4. Aguarde 24-48h e tente Baileys novamente`);
                console.log(`\n📋 OPÇÃO 3 - Executar script de resolução:`);
                console.log(`   1. Execute: .\RESOLVER_ERRO_405.ps1`);
                console.log(`   2. Siga as instruções do script`);
                console.log(`\n⚠️ IMPORTANTE:`);
                console.log(`   - QR code NÃO será gerado enquanto houver erro 405!`);
                console.log(`   - O bot precisa conseguir conectar aos servidores primeiro`);
                console.log(`   - Não tente reconectar imediatamente (piora o bloqueio)`);
                console.log(`\n${'='.repeat(60)}\n`);
                
                // Cancela qualquer restart pendente
                if (this.restartTimeout) {
                    clearTimeout(this.restartTimeout);
                    this.restartTimeout = null;
                }
                
                // Fecha socket
                try {
                    if (this.sock) {
                        this.sock.end();
                        this.sock = null;
                    }
                } catch (e) {
                    // Ignora erros
                }
                
                // Para keepalive
                if (this.keepAliveInterval) {
                    clearInterval(this.keepAliveInterval);
                    this.keepAliveInterval = null;
                }
                
                // PARA COMPLETAMENTE - não tenta reconectar automaticamente
                this.pauseRequested = true;
                this.isRestarting = false;
                
                console.log(`\n🛑 Bot parado. Reinicie manualmente após aguardar ou use whatsapp-web.js.\n`);
                
                return;
            }
            
            // Verifica erro 408 (DNS/Network) - não deve tentar reconectar infinitamente
            const isCode408 = (statusCode === 408);
            const isNetworkError = errorMessage && (
                errorMessage.includes('ENOTFOUND') || 
                errorMessage.includes('getaddrinfo') ||
                errorMessage.includes('ECONNREFUSED') ||
                errorMessage.includes('ETIMEDOUT')
            );
            
            if (isCode408 || isNetworkError) {
                console.log(`⚠️ Erro de rede/DNS detectado (código: ${statusCode})`);
                console.log(`💡 Problema: ${errorMessage}`);
                console.log(`💡 Possíveis causas:`);
                console.log(`   - Sem conexão com internet`);
                console.log(`   - Problema de DNS`);
                console.log(`   - Firewall bloqueando conexão`);
                console.log(`   - WhatsApp está fora do ar`);
                console.log(`\n⏸️ Aguardando 30 segundos antes de tentar reconectar...`);
                console.log(`   Se o problema persistir, verifique sua conexão com internet.`);
                
                // Aguarda mais tempo para erros de rede
                setTimeout(() => {
                    if (!this.started && !this.pauseRequested && this.reconnectAttempts < 3) {
                        this.reconnectAttempts++;
                        console.log(`🔄 Tentativa ${this.reconnectAttempts}/3 - Tentando reconectar após erro de rede...`);
                        this.start().catch(err => console.error('❌ Falha ao reconectar Baileys:', err));
                    } else if (this.reconnectAttempts >= 3) {
                        console.log(`⛔ Limite de tentativas de rede atingido. Parando reconexão automática.`);
                        console.log(`💡 Verifique sua conexão com internet e reinicie o bot manualmente.`);
                        this.pauseRequested = true;
                    }
                }, 30000);
                
                return;
            }
            
            // Para outros códigos de desconexão (não 440, não loggedOut, não badSession, não 405, não 408)
            if (!this.pauseRequested && statusCode !== 440 && statusCode !== 405 && statusCode !== 408) {
                // Se muitas desconexões consecutivas, aguarda mais tempo
                if (this.disconnectCount >= 3) {
                    console.log('⏸️ Muitas desconexões consecutivas. Aguardando 60 segundos antes de tentar reconectar...');
                    setTimeout(() => {
                        if (!this.started) {
                            this.start().catch(err => console.error('❌ Falha ao reconectar Baileys:', err));
                        }
                    }, 60000);
                    return;
                }

                this.reconnectAttempts++;
                
                // Limite máximo de tentativas
                if (this.reconnectAttempts > this.maxReconnectAttempts) {
                    console.log(`⛔ Limite de tentativas atingido (${this.reconnectAttempts}). Parando reconexão automática.`);
                    console.log(`💡 Para reconectar, reinicie o bot manualmente ou limpe tokens: ${this.authDir}`);
                    return; // Para de tentar reconectar
                }

                // Delay progressivo: 10s, 20s, 30s, 40s, 50s
                const delay = Math.min(10000 * this.reconnectAttempts, 50000);
                console.log(`🔄 Tentativa ${this.reconnectAttempts}/${this.maxReconnectAttempts} - Reconectando Baileys em ${delay/1000}s...`);
                
                setTimeout(() => {
                    if (!this.started) {
                        this.start().catch(err => console.error('❌ Falha ao reconectar Baileys:', err));
                    }
                }, delay);
            }
        }
    }

    startKeepAlive() {
        // Limpa keepalive anterior se existir
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
        }
        
        // Envia keepalive a cada 15 segundos para manter conexão ativa
        this.keepAliveInterval = setInterval(() => {
            if (this.sock && this.started && this.sock.user) {
                try {
                    // Envia um ping para manter conexão viva
                    this.sock.sendPresenceUpdate('available');
                } catch (e) {
                    // Ignora erros de keepalive
                }
            } else {
                // Se não está conectado, para o keepalive
                if (this.keepAliveInterval) {
                    clearInterval(this.keepAliveInterval);
                    this.keepAliveInterval = null;
                }
            }
        }, 15000); // A cada 15 segundos
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
                
                // Tenta descriptografar a mensagem - se falhar com Bad MAC, ignora completamente
                // NUNCA deixa erro Bad MAC parar o processamento
                try {
                    // Verifica se a mensagem pode ser descriptografada
                    if (msg.messageStubType === 'REVOKE' || msg.messageStubType === 'CIPHERTEXT') {
                        // Mensagens criptografadas podem causar Bad MAC se sessão estiver corrompida
                        // Continua normalmente, mas monitora erros
                    }
                } catch (decryptErr) {
                    // Trata TODOS os erros de descriptografia sem interromper o bot
                    const errorMsg = decryptErr?.message || decryptErr?.toString() || '';
                    if (errorMsg.includes('Bad MAC') || 
                        errorMsg.includes('Failed to decrypt') || 
                        errorMsg.includes('Session error') ||
                        errorMsg.includes('verifyMAC') ||
                        errorMsg.includes('decryptWithSessions')) {
                        // Usa o handler centralizado para tratar erros Bad MAC
                        // MAS continua processando outras mensagens normalmente
                        this.handleBadMacError('ao descriptografar mensagem', decryptErr);
                        continue; // Ignora esta mensagem específica e continua com a próxima
                    }
                    // Para outros erros de descriptografia, também ignora para não parar o bot
                    console.error('⚠️ Erro ao descriptografar mensagem (ignorado):', errorMsg.substring(0, 100));
                    continue; // Ignora e continua
                }

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
                
                // Aceita @lid como chat individual válido (WhatsApp Business/Enterprise)
                // @lid pode ser usado em números empresariais, mas ainda é chat individual
                
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

                // Verifica se há problema técnico na mensagem ORIGINAL (PRIORIDADE MÁXIMA)
                const hasTechnicalIssue = body.toLowerCase().includes('sem internet') || 
                                        body.toLowerCase().includes('internet caiu') ||
                                        body.toLowerCase().includes('sem conexão') ||
                                        body.toLowerCase().includes('internet parou') ||
                                        body.toLowerCase().includes('internet não funciona') ||
                                        body.toLowerCase().includes('internet lenta') ||
                                        body.toLowerCase().includes('internet travando') ||
                                        body.toLowerCase().includes('sem sinal') ||
                                        body.toLowerCase().includes('internet cai') ||
                                        body.toLowerCase().includes('caiu a internet');
                
                // Se tem problema técnico, trata como problema técnico (mesmo com saudação)
                if (hasTechnicalIssue) {
                    console.log(`🔧 [${chatId}] Problema técnico detectado, redirecionando para suporte`);
                    await this.handleSupportSubmenu(chatId, '3', context);
                    continue;
                }
                
                // Verifica se mensagem COMEÇA com saudação (não se é exatamente saudação)
                const startsWithGreeting = this.startsWithGreeting(normalized);
                
                // Se mensagem vazia ou começa com saudação SEM problema técnico, envia menu
                if (!normalized || startsWithGreeting) {
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

                // Verifica se está aguardando escolha da cobrança
                if (context.currentMenu === 'payment' && context.currentStep === 'waiting_bill_selection') {
                    const ctx = this.userStates.get(chatId);
                    
                    if (!ctx || !ctx.bills || ctx.bills.length === 0) {
                        await this.sendText(chatId, '*❌ ERRO*\n\nDados não encontrados. Por favor, envie seu CPF novamente.\n———\nDigite *8* para voltar ao menu.');
                        this.setConversationContext(chatId, {
                            currentMenu: 'payment',
                            currentStep: 'waiting_cpf'
                        });
                        continue;
                    }

                    // Verifica se é um número válido (1 até o número de cobranças)
                    const selectedNum = parseInt(normalized);
                    if (isNaN(selectedNum) || selectedNum < 1 || selectedNum > ctx.bills.length) {
                        // Formata data para exibição
                        const formatDate = (dateStr) => {
                            try {
                                if (!dateStr) return 'Data inválida';
                                
                                // Se for string no formato ISO (YYYY-MM-DD ou YYYY-MM-DDTHH:mm:ss)
                                if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
                                    // Extrai dia, mês e ano diretamente da string (ignora timezone)
                                    const parts = dateStr.split('T')[0].split('-');
                                    if (parts.length === 3) {
                                        const year = parts[0];
                                        const month = parts[1];
                                        const day = parts[2];
                                        // Log para debug (pode remover depois)
                                        console.log(`📅 [DEBUG] Data original: ${dateStr} → Formatada: ${day}/${month}/${year}`);
                                        return `${day}/${month}/${year}`;
                                    }
                                }
                                
                                // Se for número (timestamp), converte
                                if (typeof dateStr === 'number') {
                                    const date = new Date(dateStr);
                                    const day = String(date.getDate()).padStart(2, '0');
                                    const month = String(date.getMonth() + 1).padStart(2, '0');
                                    const year = date.getFullYear();
                                    return `${day}/${month}/${year}`;
                                }
                                
                                // Fallback: usa Date no timezone local (não UTC)
                                const date = new Date(dateStr);
                                if (isNaN(date.getTime())) return 'Data inválida';
                                
                                // Usa métodos locais (não UTC) para preservar o dia correto
                                const day = String(date.getDate()).padStart(2, '0');
                                const month = String(date.getMonth() + 1).padStart(2, '0');
                                const year = date.getFullYear();
                                return `${day}/${month}/${year}`;
                            } catch {
                                return 'Data inválida';
                            }
                        };

                        // Formata valor para exibição
                        const formatValue = (value) => {
                            try {
                                const num = parseFloat(value) || 0;
                                return `R$ ${num.toFixed(2).replace('.', ',')}`;
                            } catch {
                                return 'R$ 0,00';
                            }
                        };

                        let billsMenu = `*Selecione qual cobrança deseja pagar:*\n\n`;
                        ctx.bills.forEach((bill, index) => {
                            const num = index + 1;
                            const vencimento = formatDate(bill.dataVencimento);
                            billsMenu += `*${num}️⃣* Vencimento: *${vencimento}*\n`;
                        });
                        billsMenu += `\n———\n*DIGITE O NÚMERO DA OPÇÃO COM A DATA DA COBRANÇA DESEJADA.*\n\n———\n*DIGITE 8 PARA VOLTAR AO MENU.*`;
                        await this.sendText(chatId, billsMenu);
                        continue;
                    }

                    // Cobrança selecionada válida
                    const selectedBill = ctx.bills[selectedNum - 1];
                    
                    // Atualiza userStates com o billId escolhido
                    this.userStates.set(chatId, {
                        ...ctx,
                        billId: selectedBill.id
                    });

                    // Formata data e valor para exibição
                    const formatDate = (dateStr) => {
                        try {
                            if (!dateStr) return 'Data inválida';
                            
                            // Se for string no formato ISO (YYYY-MM-DD ou YYYY-MM-DDTHH:mm:ss)
                            if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
                                // Extrai dia, mês e ano diretamente da string (ignora timezone)
                                const parts = dateStr.split('T')[0].split('-');
                                if (parts.length === 3) {
                                    const year = parts[0];
                                    const month = parts[1];
                                    const day = parts[2];
                                    return `${day}/${month}/${year}`;
                                }
                            }
                            
                            // Fallback: usa Date no timezone local (não UTC)
                            // Se a API retorna data sem timezone, assume timezone local
                            const date = new Date(dateStr);
                            if (isNaN(date.getTime())) return 'Data inválida';
                            
                            // Usa métodos locais (não UTC) para preservar o dia correto
                            const day = String(date.getDate()).padStart(2, '0');
                            const month = String(date.getMonth() + 1).padStart(2, '0');
                            const year = date.getFullYear();
                            return `${day}/${month}/${year}`;
                        } catch {
                            return 'Data inválida';
                        }
                    };

                    const formatValue = (value) => {
                        try {
                            const num = parseFloat(value) || 0;
                            return `R$ ${num.toFixed(2).replace('.', ',')}`;
                        } catch {
                            return 'R$ 0,00';
                        }
                    };

                    // Mostra menu PIX/Boleto para a cobrança escolhida
                    const paymentOptionMsg = `*Cobrança selecionada:*

📅 *Vencimento:* ${formatDate(selectedBill.dataVencimento)}
💰 *Valor:* ${formatValue(selectedBill.valor)}

Como você deseja pagar?

*1️⃣ PIX* (ou digite *pix*)

*2️⃣ BOLETO*

⏱️ *Liberação em até 5 minutos após o pagamento*

———
Digite o *número* da opção ou *8* para voltar ao menu.`;

                    this.setConversationContext(chatId, {
                        currentMenu: 'payment',
                        currentStep: 'waiting_payment_option'
                    });

                    await this.sendText(chatId, paymentOptionMsg);
                    continue;
                }

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
        // Mantém @lid como está (WhatsApp Business/Enterprise)
        if (id.includes('@lid')) return id;
        if (id.includes('-')) {
            return id.endsWith('@g.us') ? id : `${id}@g.us`;
        }
        id = id.replace(/\D/g, '');
        return `${id}@s.whatsapp.net`;
    }

    toPanelChatId(jid) {
        if (!jid) return '';
        if (jid.endsWith('@s.whatsapp.net')) return jid.replace('@s.whatsapp.net', '@c.us');
        // Mantém @lid como está (WhatsApp Business/Enterprise)
        if (jid.endsWith('@lid')) return jid;
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
    
    /**
     * Verifica se a mensagem COMEÇA com saudação (mesmo que tenha mais texto depois)
     */
    startsWithGreeting(normalizedText) {
        if (!normalizedText) return false;
        
        // Lista de saudações (sem acentos, minúsculas)
        const greetings = [
            'oi', 'oie', 'oii', 'oiii', 'ola', 'olaa', 'olaaa',
            'bom dia', 'bomdia', 'boa tarde', 'boatarde',
            'boa noite', 'boanoite'
        ];
        
        // Remove espaços/pontuação do início
        const cleaned = normalizedText.trim();
        
        // Verifica se é exatamente uma saudação
        if (greetings.includes(cleaned)) {
            return true;
        }
        
        // Verifica se COMEÇA com saudação (seguida de espaço, ponto, vírgula, etc)
        for (const greeting of greetings) {
            // Verifica padrões: "oi ", "oi.", "oi,", "bom dia ", "bom dia,", etc
            if (cleaned.startsWith(greeting + ' ') || 
                cleaned.startsWith(greeting + '.') || 
                cleaned.startsWith(greeting + ',') ||
                cleaned.startsWith(greeting + '!') ||
                cleaned.startsWith(greeting + '?')) {
                return true;
            }
        }
        
        return false;
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
        const errorData = error?.response?.data?.data || error?.response?.data || {};
        
        // Erro de autenticação/token revogado
        const isTokenRevoked = (
            error?.response?.status === 400 || error?.response?.status === 401
        ) && (
            errorData?.error === 'access_denied' ||
            errorData?.hint === 'Access token has been revoked' ||
            errorData?.errorDescription?.includes('denied') ||
            errorData?.errorDescription?.includes('revoked')
        );

        if (isTokenRevoked) {
            return {
                userMessage: '⚠️ *Erro de autenticação*\n\nNossa API está com problema de autenticação. Por favor, tente novamente em alguns instantes.\n\n———\nDigite *8* para voltar ao menu.',
                logMessage: 'Token revogado ou acesso negado'
            };
        }
        
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

            // Filtra cobranças: aceita APENAS não pagas (dataPagamento === null)
            const filteredBills = bills.filter(bill => {
                // Aceita cobrança que tenha ID válido
                if (!bill || !bill.id) {
                    return false;
                }

                // CRITÉRIO PRINCIPAL: Verifica se está pago pelo campo dataPagamento
                // Se dataPagamento não for null/undefined/string vazia, significa que foi pago
                const dataPagamento = bill.dataPagamento || bill.data_pagamento;
                if (dataPagamento !== null && dataPagamento !== undefined && dataPagamento !== '') {
                    return false; // Já foi pago, exclui da lista
                }

                // Verificação adicional: se statusDescricao indica pago, também exclui (segurança extra)
                const statusDescricao = (bill.statusDescricao || bill.status_descricao || '').toLowerCase();
                if (statusDescricao.includes('pago') || statusDescricao.includes('quitado') ||
                    statusDescricao.includes('liquidado') || statusDescricao.includes('cancelado')) {
                    return false; // Status indica pago, exclui
                }

                // Se passou nas verificações acima, é uma cobrança não paga (dataPagamento === null)
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

            const sortedBills = filteredBills.sort((a, b) => {
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
            });

            // Formata data para exibição
            const formatDate = (dateStr) => {
                try {
                    if (!dateStr) return 'Data inválida';
                    
                    // Se for string no formato ISO (YYYY-MM-DD ou YYYY-MM-DDTHH:mm:ss)
                    if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
                        // Extrai dia, mês e ano diretamente da string (ignora timezone)
                        const parts = dateStr.split('T')[0].split('-');
                        if (parts.length === 3) {
                            const year = parts[0];
                            const month = parts[1];
                            const day = parts[2];
                            return `${day}/${month}/${year}`;
                        }
                    }
                    
                    // Fallback: usa Date no timezone local (não UTC)
                    // Se a API retorna data sem timezone, assume timezone local
                    const date = new Date(dateStr);
                    if (isNaN(date.getTime())) return 'Data inválida';
                    
                    // Usa métodos locais (não UTC) para preservar o dia correto
                    const day = String(date.getDate()).padStart(2, '0');
                    const month = String(date.getMonth() + 1).padStart(2, '0');
                    const year = date.getFullYear();
                    return `${day}/${month}/${year}`;
                } catch {
                    return 'Data inválida';
                }
            };

            // Formata valor para exibição
            const formatValue = (value) => {
                try {
                    const num = parseFloat(value) || 0;
                    return `R$ ${num.toFixed(2).replace('.', ',')}`;
                } catch {
                    return 'R$ 0,00';
                }
            };

            // Guarda contexto do usuário com todas as cobranças disponíveis
            this.userStates.set(chatId, {
                clientId: cli.id,
                serviceId: activeService.id,
                bills: sortedBills.map(bill => ({
                    id: bill.id,
                    dataVencimento: bill.dataVencimento || bill.data_vencimento || bill.vencimento,
                    valor: bill.valor || bill.valorTotal || bill.valor_total || 0
                })),
                clientName: cli?.nome || 'cliente',
                lastActivity: Date.now()
            });

            // Log para debug: mostra quantas cobranças foram encontradas
            console.log(`📊 [${chatId}] Cobranças encontradas: ${sortedBills.length}`);
            if (sortedBills.length > 0) {
                console.log(`📋 [${chatId}] Datas de vencimento:`, sortedBills.map(b => b.dataVencimento || b.data_vencimento || b.vencimento));
            }
            
            // Se tem apenas uma cobrança, vai direto para escolha PIX/Boleto
            if (sortedBills.length === 1) {
                const bill = sortedBills[0];
                this.userStates.set(chatId, {
                    ...this.userStates.get(chatId),
                    billId: bill.id
                });

                const paymentOptionMsg = `*CPF CONFIRMADO: ${cli?.nome || 'Cliente'}*

📅 *Vencimento:* ${formatDate(bill.dataVencimento || bill.data_vencimento || bill.vencimento)}
💰 *Valor:* ${formatValue(bill.valor || bill.valorTotal || bill.valor_total)}

Como você deseja pagar?

*1️⃣ PIX* (ou digite *pix*)

*2️⃣ BOLETO*

⏱️ *Liberação em até 5 minutos após o pagamento*

———
Digite o *número* da opção ou *8* para voltar ao menu.`;

                this.setConversationContext(chatId, {
                    currentMenu: 'payment',
                    currentStep: 'waiting_payment_option'
                });

                await this.sendText(chatId, paymentOptionMsg);
                return;
            }

            // Se tem múltiplas cobranças, mostra menu para escolher
            let billsMenu = `*CPF CONFIRMADO: ${cli?.nome || 'Cliente'}*\n\n`;
            billsMenu += `*Selecione qual cobrança deseja pagar:*\n\n`;

            sortedBills.forEach((bill, index) => {
                const num = index + 1;
                const vencimento = formatDate(bill.dataVencimento || bill.data_vencimento || bill.vencimento);
                billsMenu += `*${num}️⃣* Vencimento: *${vencimento}*\n`;
            });

                        billsMenu += `\n———\n*DIGITE O NÚMERO DA OPÇÃO COM A DATA DA COBRANÇA DESEJADA.*\n\n———\n*DIGITE 8 PARA VOLTAR AO MENU.*`;

            // Atualiza contexto: aguardando escolha da cobrança
            this.setConversationContext(chatId, {
                currentMenu: 'payment',
                currentStep: 'waiting_bill_selection'
            });

            await this.sendText(chatId, billsMenu);
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

    /**
     * Trata erros Bad MAC e implementa limpeza automática de sessão quando necessário
     */
    handleBadMacError(context, err) {
        // Proteção contra chamadas antes da inicialização completa
        if (typeof this.badMacErrorCount === 'undefined') {
            this.badMacErrorCount = 0;
            this.badMacErrorThreshold = 5;
            this.lastBadMacErrorTime = 0;
            this.badMacErrorWindow = 3 * 60 * 1000;
            this.lastBadMacLogTime = 0; // Timestamp do último log detalhado
        }
        
        const now = Date.now();
        
        // Se passou muito tempo desde o último erro, reseta o contador
        if (now - this.lastBadMacErrorTime > this.badMacErrorWindow) {
            this.badMacErrorCount = 0;
        }
        
        this.badMacErrorCount++;
        this.lastBadMacErrorTime = now;
        
        // Reduz verbosidade: só mostra logs detalhados a cada 5 erros ou a cada 30 segundos
        const shouldLogDetails = this.badMacErrorCount === 1 || 
                                 this.badMacErrorCount % 5 === 0 || 
                                 (now - (this.lastBadMacLogTime || 0)) > 30000;
        
        if (shouldLogDetails) {
            this.lastBadMacLogTime = now;
            console.error(`❌ ERRO Bad MAC detectado ${context} (${this.badMacErrorCount}/${this.badMacErrorThreshold})`);
            
            // Só mostra detalhes completos no primeiro erro ou quando próximo do limite
            if (this.badMacErrorCount === 1 || this.badMacErrorCount >= this.badMacErrorThreshold - 1) {
                console.error('💡 Isso geralmente indica:');
                console.error('   - Sessão corrompida ou tokens inválidos após alguns dias');
                console.error('   - Múltiplas instâncias usando a mesma sessão');
                console.error('   - Conflito entre diferentes versões do código');
                console.error(`📁 Diretório de tokens: ${this.authDir}`);
            }
        }
        
        // Se atingiu o limite de erros, limpa a sessão e reconecta
        // IMPORTANTE: Isso é feito de forma assíncrona e não bloqueia o bot
        if (this.badMacErrorCount >= this.badMacErrorThreshold) {
            console.error('');
            console.error('⚠️⚠️⚠️ LIMITE DE ERROS BAD MAC ATINGIDO ⚠️⚠️⚠️');
            const timeWindow = Math.round((now - (this.lastBadMacErrorTime - this.badMacErrorWindow)) / 1000);
            console.error(`   ${this.badMacErrorCount} erros em ${timeWindow} segundos`);
            console.error('🔄 Limpando sessão corrompida e forçando reconexão...');
            console.error('💡 O bot continuará funcionando durante a limpeza!');
            console.error('');
            
            // Limpa a sessão e reconecta de forma assíncrona (não bloqueia)
            // Usa setImmediate para não bloquear o event loop
            setImmediate(() => {
                this.cleanupAndReconnect().catch(e => {
                    console.error('⚠️ Erro ao limpar e reconectar (bot continua funcionando):', e.message);
                    // Reseta flag para permitir nova tentativa
                    this.isRestarting = false;
                });
            });
        } else if (shouldLogDetails && this.badMacErrorCount < this.badMacErrorThreshold - 1) {
            console.error(`💡 Limpeza automática será acionada após ${this.badMacErrorThreshold - this.badMacErrorCount} erros adicionais`);
        }
    }

    /**
     * Limpa sessão corrompida e força reconexão
     * IMPORTANTE: Não para o bot permanentemente, apenas reconecta
     */
    async cleanupAndReconnect() {
        // Evita múltiplas limpezas simultâneas
        if (this.isRestarting) {
            console.log('⚠️ Limpeza já em andamento, aguardando...');
            return;
        }
        
        try {
            console.log('🧹 Iniciando limpeza de sessão corrompida...');
            
            // Marca como reiniciando para evitar múltiplas tentativas
            this.isRestarting = true;
            
            // Fecha socket atual de forma segura
            if (this.sock) {
                try {
                    if (this.sock.ev) {
                        this.sock.ev.removeAllListeners();
                    }
                    if (this.sock.ws) {
                        this.sock.ws.close();
                    }
                } catch (e) {
                    // Ignora erros ao fechar - não é crítico
                }
                this.sock = null;
            }
            
            // NÃO marca started como false aqui - queremos reconectar rapidamente
            
            // Limpa apenas arquivos de sessão específicos (não tudo)
            // Mantém credenciais principais mas limpa sessões corrompidas
            const criticalFiles = ['creds.json', 'keys.json', 'app-state-sync-key.json', 'app-state-sync-version.json'];
            const sessionFiles = [
                'app-state-sync-key-*',
                'app-state-sync-version-*',
                'pre-key-*',
                'session-*',
                'sender-key-*'
            ];
            
            if (fs.existsSync(this.authDir)) {
                const files = fs.readdirSync(this.authDir);
                let cleanedCount = 0;
                
                for (const file of files) {
                    // NUNCA remove arquivos críticos
                    if (criticalFiles.includes(file)) {
                        continue;
                    }
                    
                    // Remove apenas arquivos de sessão específicos
                    const shouldRemove = sessionFiles.some(pattern => {
                        const regex = new RegExp(pattern.replace('*', '.*'));
                        return regex.test(file);
                    });
                    
                    if (shouldRemove) {
                        try {
                            fs.unlinkSync(path.join(this.authDir, file));
                            cleanedCount++;
                        } catch (e) {
                            console.error(`⚠️ Erro ao remover ${file}:`, e.message);
                        }
                    }
                }
                
                console.log(`✅ ${cleanedCount} arquivos de sessão removidos (credenciais principais preservadas)`);
            }
            
            // Reseta contadores
            this.badMacErrorCount = 0;
            this.lastBadMacErrorTime = 0;
            this.reconnectAttempts = 0;
            
            console.log('🔄 Aguardando 3 segundos antes de reconectar...');
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Reconecta SEMPRE, mesmo se houver erro
            console.log('🔄 Reconectando após limpeza...');
            this.isRestarting = false;
            
            // Tenta reconectar - se falhar, tenta novamente SEMPRE
            try {
                await this.start();
            } catch (startErr) {
                console.error('⚠️ Erro ao reconectar após limpeza, tentando novamente em 10s:', startErr.message);
                this.isRestarting = false;
                // Tenta novamente após 10 segundos - NUNCA desiste
                setTimeout(() => {
                    this.start().catch(err => {
                        console.error('⚠️ Falha ao reconectar após limpeza (continuando tentativas):', err.message);
                        // Continua tentando - não desiste nunca
                        this.isRestarting = false;
                    });
                }, 10000);
            }
            
        } catch (e) {
            console.error('⚠️ Erro ao limpar e reconectar (continuando tentativas):', e.message);
            this.isRestarting = false;
            // SEMPRE tenta reconectar mesmo com erro - nunca desiste
            setTimeout(() => {
                this.start().catch(err => {
                    console.error('⚠️ Falha ao reconectar após limpeza (continuando):', err.message);
                    this.isRestarting = false;
                });
            }, 10000);
        }
    }

    /**
     * Limpeza periódica de sessões antigas/corrompidas
     * Remove sessões que não foram usadas há mais de 7 dias
     * NUNCA remove credenciais principais (creds.json, keys.json, etc)
     */
    cleanupOldSessions() {
        try {
            if (!fs.existsSync(this.authDir)) {
                return;
            }
            
            // Arquivos críticos que NUNCA devem ser removidos
            const criticalFiles = ['creds.json', 'keys.json', 'app-state-sync-key.json', 'app-state-sync-version.json'];
            
            const files = fs.readdirSync(this.authDir);
            const now = Date.now();
            const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 dias
            let cleanedCount = 0;
            
            for (const file of files) {
                // NUNCA remove arquivos críticos
                if (criticalFiles.includes(file)) {
                    continue;
                }
                
                const filePath = path.join(this.authDir, file);
                try {
                    const stats = fs.statSync(filePath);
                    const age = now - stats.mtimeMs;
                    
                    // Remove apenas arquivos de sessão antigos específicos
                    // Não remove credenciais principais ou arquivos de estado global
                    if (age > maxAge && (
                        file.startsWith('session-') || 
                        file.startsWith('pre-key-') || 
                        file.startsWith('sender-key-') ||
                        file.startsWith('app-state-sync-key-') ||
                        file.startsWith('app-state-sync-version-')
                    )) {
                        fs.unlinkSync(filePath);
                        cleanedCount++;
                    }
                } catch (e) {
                    // Ignora erros ao verificar/remover arquivos
                }
            }
            
            if (cleanedCount > 0) {
                console.log(`🧹 Limpeza periódica: ${cleanedCount} sessões antigas removidas`);
            }
        } catch (e) {
            console.error('⚠️ Erro na limpeza periódica de sessões:', e.message);
        }
    }

    async stop() {
        try {
            // Restaura stderr original
            if (this.originalStderrWrite) {
                process.stderr.write = this.originalStderrWrite;
            }
            
            // Cancela restart pendente se existir
            if (this.restartTimeout) {
                clearTimeout(this.restartTimeout);
                this.restartTimeout = null;
            }
            
            // Para keepalive se estiver rodando
            if (this.keepAliveInterval) {
                clearInterval(this.keepAliveInterval);
                this.keepAliveInterval = null;
            }
            
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
            this.isRestarting = false;
            this.started = false;
        }
    }
}

module.exports = BaileysBot;

