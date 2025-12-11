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
        this.qrGeneratedTime = 0; // Timestamp de quando QR foi gerado (para detectar QR recente)
        this.authState = null; // Estado de autenticação para verificar credenciais
        this.silentMode = true; // Modo silencioso - apenas logs críticos
        
        // Helper para logs críticos apenas
        this.log = {
            critical: (...args) => console.log(...args), // Apenas críticos
            error: (...args) => console.error(...args), // Apenas erros críticos
            qr: (...args) => console.log(...args), // QR code sempre mostra
            connect: (...args) => console.log(...args), // Conexão sempre mostra
            // Todos os outros logs são ignorados
            debug: () => {},
            info: () => {},
            warn: () => {},
            detail: () => {},
            verbose: () => {}
        };
        
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
        
        // Intercepta stderr E stdout para capturar erros Bad MAC e filtrar logs de sessão
        // Isso é necessário porque o libsignal escreve diretamente no stderr/stdout
        // Também filtra mensagens normais que não são erros reais
        this.originalStderrWrite = process.stderr.write.bind(process.stderr);
        this.originalStdoutWrite = process.stdout.write.bind(process.stdout);
        this.stderrFilterCount = 0; // Contador para reduzir spam de logs
        this.lastStderrLogTime = 0; // Timestamp do último log filtrado
        const self = this;
        
        // Intercepta stdout para filtrar logs de "Closing session" que poluem o console
        process.stdout.write = function(chunk, encoding, fd) {
            const message = chunk ? chunk.toString() : '';
            
            // Filtra logs enormes de sessão do libsignal
            if (message.includes('Closing session:') || 
                message.includes('SessionEntry') ||
                message.includes('_chains:') ||
                message.includes('chainKey:') ||
                message.includes('currentRatchet:') ||
                message.includes('ephemeralKeyPair:') ||
                message.includes('indexInfo:') ||
                message.includes('registrationId:') ||
                message.includes('remoteIdentityKey:') ||
                message.includes('pendingPreKey:') ||
                message.includes('baseKey:') ||
                message.includes('rootKey:') ||
                message.includes('pubKey:') ||
                message.includes('privKey:') ||
                message.includes('<Buffer')) {
                // Não escreve - são logs normais de gerenciamento de sessão
                return true;
            }
            
            // Para outras mensagens, escreve normalmente
            return self.originalStdoutWrite(chunk, encoding, fd);
        };
        
        process.stderr.write = function(chunk, encoding, fd) {
            const message = chunk ? chunk.toString() : '';
            
            // Filtra mensagens normais do libsignal que não são erros
            const normalMessages = [
                'Closing open session',
                'Closing stale open session',
                'in favor of incoming prekey bundle',
                'for new outgoing prekey bundle',
                'Closing session:', // Logs enormes de SessionEntry que poluem o console
                'SessionEntry', // Objetos SessionEntry completos
                '_chains:', // Parte dos logs de sessão
                'chainKey:', // Parte dos logs de sessão
                'currentRatchet:', // Parte dos logs de sessão
                'ephemeralKeyPair:', // Parte dos logs de sessão
                'indexInfo:', // Parte dos logs de sessão
                'registrationId:', // Parte dos logs de sessão
                'remoteIdentityKey:', // Parte dos logs de sessão
                'pendingPreKey:', // Parte dos logs de sessão
                'baseKey:', // Parte dos logs de sessão
                'rootKey:', // Parte dos logs de sessão
                'pubKey:', // Parte dos logs de sessão
                'privKey:', // Parte dos logs de sessão
                '<Buffer' // Buffers de chaves criptográficas
            ];
            
            // Verifica se a mensagem contém qualquer uma das strings normais
            const isNormalMessage = normalMessages.some(normal => message.includes(normal));
            
            // Se for mensagem normal, não escreve no stderr (reduz spam)
            if (isNormalMessage) {
                return true; // Retorna true para indicar que foi "escrito" mas não escreve nada
            }
            
            // Filtra também mensagens que são objetos SessionEntry completos (muito grandes)
            // Esses logs aparecem quando o libsignal fecha sessões antigas (comportamento normal)
            if (message.includes('SessionEntry') || message.includes('Closing session')) {
                return true; // Não escreve - são logs normais de gerenciamento de sessão
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
        // Logs de inicialização removidos - não críticos
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
        
        // SISTEMA DE HEALTH CHECK - Detecta quando bot recebe mensagens mas não responde
        this.lastReceivedMessageTime = 0; // Timestamp da última mensagem recebida
        this.lastSentMessageTime = 0; // Timestamp da última mensagem enviada com sucesso
        this.healthCheckInterval = null; // Interval do health check
        this.failedSendAttempts = 0; // Contador de tentativas de envio falhadas
        this.maxFailedSendAttempts = 3; // Máximo de tentativas falhadas antes de forçar reconexão
        this.lastHealthCheckLog = 0; // Timestamp do último log de status do health check
        
        // SISTEMA DE AUTO-RECUPERAÇÃO - GARANTE QUE O BOT NUNCA PARE COMPLETAMENTE
        this.autoRecoveryEnabled = true; // Sempre ativo
        this.watchdogInterval = null; // Interval do watchdog
        this.lastSuccessfulConnection = Date.now(); // Timestamp da última conexão bem-sucedida
        this.maxTimeWithoutConnection = 5 * 60 * 1000; // 5 minutos sem conexão = força reconexão
        this.forceReconnectTimeout = null; // Timeout para forçar reconexão mesmo com pauseRequested
        
        // SISTEMA ROBUSTO DE AUTENTICAÇÃO - EVITA PERDA DE SESSÃO
        this.saveCreds = null; // Função de salvamento de credenciais
        this.credBackupDir = path.join(__dirname, 'auth-backups'); // Diretório de backup
        this.lastCredSave = 0; // Timestamp do último salvamento
        this.credSaveInterval = null; // Interval para salvamento periódico
        this.sessionValidationInterval = null; // Interval para validação periódica da sessão
        this.minCredSaveInterval = 30000; // Salva credenciais no mínimo a cada 30 segundos
        
        // Contadores para erros Bad MAC (sessão corrompida)
        // AUMENTADO: 10 erros em 5 minutos (antes: 5 em 3 minutos)
        // Isso evita limpezas desnecessárias quando há erros esporádicos normais
        this.badMacErrorCount = 0; // Contador de erros Bad MAC consecutivos
        this.badMacErrorThreshold = 10; // Limite de erros antes de limpar sessão
        this.lastBadMacErrorTime = 0; // Timestamp do último erro Bad MAC
        this.badMacErrorWindow = 5 * 60 * 1000; // Janela de 5 minutos para contar erros (antes: 3 minutos)
        this.lastBadMacLogTime = 0; // Timestamp do último log detalhado de Bad MAC
        this.lastCleanupTime = 0; // Timestamp da última limpeza (evita loops)
        this.cleanupCooldown = 10 * 60 * 1000; // Cooldown de 10 minutos entre limpezas
        
        
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
        // Log removido - não crítico
    }

    async start() {
        if (this.started) {
            // Já iniciado - não precisa logar
            return;
        }
        
        if (this.isRestarting) {
            // Já reiniciando - não precisa logar
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
            // Aguardando para evitar erro 405
            await new Promise(resolve => setTimeout(resolve, totalWaitTime));
        }

        console.log('📡 Carregando estado de autenticação...');
        const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
        this.saveCreds = saveCreds;
        this.authState = state; // Salva state para verificar depois
        
        // CONTROLE DE VERSÃO: Desabilitado por padrão em produção
        // Atualizações automáticas podem quebrar o bot em produção
        // Para habilitar, defina BAILEYS_AUTO_UPDATE=true no .env
        let version;
        if (process.env.BAILEYS_AUTO_UPDATE === 'true') {
            console.log('📦 Buscando versão mais recente do Baileys...');
            try {
                const versionInfo = await fetchLatestBaileysVersion();
                version = versionInfo.version;
                console.log(`✅ Versão Baileys: ${version.join('.')} ${versionInfo.isLatest ? '(mais recente)' : '(atualização disponível)'}`);
            } catch (error) {
                console.log('⚠️ Não foi possível verificar versão do Baileys (usando versão padrão)');
                // Usa versão padrão se falhar
                version = undefined; // Baileys vai usar versão padrão
            }
        } else {
            // Usa versão fixa do package.json (mais seguro para produção)
            const baileysPackage = require('@whiskeysockets/baileys/package.json');
            console.log(`✅ Versão Baileys fixa: ${baileysPackage.version} (atualizações automáticas desabilitadas)`);
            // Não define version - Baileys vai usar versão padrão do código instalado
            version = undefined; // Baileys detecta automaticamente a versão do código
        }

        // Verifica se há credenciais salvas
        const hasCredentials = state.creds && state.creds.me;
        // Estado de autenticação verificado
        
        // MELHORADO: Se não há credenciais, tenta restaurar do backup
        if (!hasCredentials) {
            // Tentando restaurar credenciais do backup
            const restored = this.restoreCredentialsFromBackup();
            if (restored) {
                // Recarrega estado após restaurar
                const { state: restoredState, saveCreds: restoredSaveCreds } = await useMultiFileAuthState(this.authDir);
                this.saveCreds = restoredSaveCreds;
                this.authState = restoredState;
                const hasRestoredCreds = restoredState.creds && restoredState.creds.me;
                if (hasRestoredCreds) {
                    // Credenciais restauradas do backup
                }
            }
        } else {
            // Verifica se credenciais estão válidas
            if (!state.creds.registered || !state.creds.account) {
                // Tenta restaurar do backup se credenciais parecem inválidas
                const restored = this.restoreCredentialsFromBackup();
                if (restored) {
                    const { state: restoredState, saveCreds: restoredSaveCreds } = await useMultiFileAuthState(this.authDir);
                    this.saveCreds = restoredSaveCreds;
                    this.authState = restoredState;
                }
            }
        }

        // Configuração otimizada para evitar erro 405
        // Aumenta delays e timeouts para evitar rate limiting
        const socketConfig = {
            ...(version && { version }), // Só inclui version se estiver definido
            auth: state,
            logger: this.logger,
            browser: Browsers.macOS('Chrome'),
            markOnlineOnConnect: false, // Mudado para false para evitar detecção
            syncFullHistory: false,
            emitOwnEvents: false,
            generateHighQualityLinkPreview: false,
            // printQRInTerminal foi removido (deprecated) - estamos imprimindo manualmente
            // MELHORADO: Timeouts aumentados para VPS e conexões de longa duração
            // VPS geralmente tem latência maior e rede menos estável
            // Timeouts maiores evitam desconexões em servidores remotos
            connectTimeoutMs: 600000, // 10 minutos (dobrado para VPS com rede ruim)
            defaultQueryTimeoutMs: 600000, // 10 minutos (dobrado para VPS)
            keepAliveIntervalMs: 30000, // Keepalive a cada 30 segundos (mais frequente para VPS)
            qrTimeout: 600000, // 10 minutos (dobrado para VPS)
            // Configurações adicionais para manter conexão estável
            shouldReconnectSocket: () => true, // Sempre tenta reconectar se socket cair
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
        };
        
        this.sock = makeWASocket(socketConfig);

        this.client = this.sock;
        
        // Marca como não reiniciando quando conecta com sucesso
        this.isRestarting = false;
        if (this.restartTimeout) {
            clearTimeout(this.restartTimeout);
            this.restartTimeout = null;
        }

        // Listener único para connection.update (evita duplicação)
        this.sock.ev.on('connection.update', (update) => {
            // Processa atualização através do handler principal
            this.handleConnectionUpdate(update).catch(err => {
                if (!err.message?.includes('Bad MAC')) {
                    this.log.error('ERRO conexão:', err.message);
                }
            });
        });

        // Salva credenciais sempre que atualizar (silenciosamente)
        // MELHORADO: Salva imediatamente e cria backup
        this.sock.ev.on('creds.update', () => {
            try {
                // Salva credenciais imediatamente
                saveCreds();
                this.lastCredSave = Date.now();
                
                // Cria backup periódico (a cada 5 minutos)
                const now = Date.now();
                if (now - (this.lastCredBackup || 0) > 5 * 60 * 1000) {
                    this.backupCredentials();
                    this.lastCredBackup = now;
                }
            } catch (e) {
                // Erro ao salvar credenciais - não crítico, continua
            }
        });
        
        // INICIA SALVAMENTO PERIÓDICO DE CREDENCIAIS (a cada 30 segundos)
        this.startPeriodicCredSave();
        
        // INICIA VALIDAÇÃO PERIÓDICA DA SESSÃO (a cada 2 minutos)
        this.startSessionValidation();
        
        // INICIA HEALTH CHECK - Detecta quando bot recebe mensagens mas não responde
        this.startHealthCheck();

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
                }
                // Erros não críticos são ignorados - bot continua funcionando
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
            }
            // Erros não críticos são ignorados - bot continua funcionando
            // NUNCA re-lança o erro - o bot deve continuar funcionando sempre
        });

        this.started = true;
        this.initialized = true; // Marca como inicializado
        this.lastSuccessfulConnection = Date.now(); // Atualiza timestamp de conexão
        
        // INICIA WATCHDOG DE AUTO-RECUPERAÇÃO
        this.startWatchdog();
    }
    
    /**
     * WATCHDOG DE AUTO-RECUPERAÇÃO - Verifica periodicamente se o bot está conectado
     * Se não estiver conectado por muito tempo, força reconexão mesmo com pauseRequested
     */
    startWatchdog() {
        // Limpa watchdog anterior se existir
        if (this.watchdogInterval) {
            clearInterval(this.watchdogInterval);
        }
        
        // Verifica a cada 30 segundos se o bot está conectado
        this.watchdogInterval = setInterval(() => {
            try {
                const now = Date.now();
                const isConnected = this.sock && 
                                   this.sock.ws && 
                                   this.sock.ws.readyState === 1 && // 1 = OPEN
                                   this.started;
                
                if (isConnected) {
                    // Bot está conectado - atualiza timestamp
                    this.lastSuccessfulConnection = now;
                    return; // Tudo OK, não faz nada
                }
                
                // Bot NÃO está conectado
                const timeSinceLastConnection = now - this.lastSuccessfulConnection;
                
                // Se passou mais de 5 minutos sem conexão, força reconexão
                if (timeSinceLastConnection > this.maxTimeWithoutConnection) {
                    console.log('');
                    console.log('⚠️⚠️⚠️ WATCHDOG: Bot desconectado há mais de 5 minutos ⚠️⚠️⚠️');
                    console.log('🔄 Forçando reconexão automática...');
                    console.log('');
                    
                    // Reseta pauseRequested para permitir reconexão
                    this.pauseRequested = false;
                    this.started = false; // Permite novo start
                    
                    // Limpa timeouts anteriores
                    if (this.forceReconnectTimeout) {
                        clearTimeout(this.forceReconnectTimeout);
                    }
                    
                    // Força reconexão após 5 segundos
                    this.forceReconnectTimeout = setTimeout(() => {
                        if (!this.started && !this.isRestarting) {
                            console.log('🔄 Watchdog: Iniciando reconexão forçada...');
                            this.start().catch(err => {
                                console.error('❌ Watchdog: Erro ao reconectar:', err.message);
                                // Tenta novamente em 2 minutos se falhar
                                setTimeout(() => {
                                    if (!this.started && !this.isRestarting) {
                                        console.log('🔄 Watchdog: Segunda tentativa de reconexão...');
                                        this.start().catch(e => console.error('❌ Watchdog: Falha na segunda tentativa:', e.message));
                                    }
                                }, 120000);
                            });
                        }
                    }, 5000);
                }
            } catch (e) {
                // Ignora erros no watchdog para não quebrar o sistema
                console.error('⚠️ Erro no watchdog (ignorado):', e.message);
            }
        }, 30000); // Verifica a cada 30 segundos
    }
    
    /**
     * Para o watchdog (apenas se realmente necessário)
     */
    stopWatchdog() {
        if (this.watchdogInterval) {
            clearInterval(this.watchdogInterval);
            this.watchdogInterval = null;
        }
        if (this.forceReconnectTimeout) {
            clearTimeout(this.forceReconnectTimeout);
            this.forceReconnectTimeout = null;
        }
    }
    
    /**
     * SALVAMENTO PERIÓDICO DE CREDENCIAIS - Garante que credenciais sejam salvas regularmente
     * Mesmo se creds.update não disparar, salva a cada 30 segundos
     */
    startPeriodicCredSave() {
        // Limpa intervalo anterior se existir
        if (this.credSaveInterval) {
            clearInterval(this.credSaveInterval);
        }
        
        this.credSaveInterval = setInterval(() => {
            try {
                // Só salva se passou tempo suficiente desde último salvamento
                const now = Date.now();
                if (now - this.lastCredSave > this.minCredSaveInterval && this.saveCreds) {
                    this.saveCreds();
                    this.lastCredSave = now;
                }
            } catch (e) {
                // Ignora erros para não quebrar o sistema
                console.error('⚠️ Erro no salvamento periódico (ignorado):', e.message);
            }
        }, 30000); // A cada 30 segundos
    }
    
    /**
     * VALIDAÇÃO PERIÓDICA DA SESSÃO - Verifica se a sessão ainda está válida
     * Se detectar problemas, tenta recuperar antes que a sessão seja invalidada
     */
    startSessionValidation() {
        // Limpa intervalo anterior se existir
        if (this.sessionValidationInterval) {
            clearInterval(this.sessionValidationInterval);
        }
        
        this.sessionValidationInterval = setInterval(() => {
            try {
                // Verifica se socket está conectado e válido
                const isConnected = this.sock && 
                                   this.sock.ws && 
                                   this.sock.ws.readyState === 1;
                
                // Verifica se credenciais existem e são válidas
                const hasValidCreds = this.authState?.creds?.me && 
                                     this.authState?.creds?.registered;
                
                // Se está conectado mas credenciais parecem inválidas, força salvamento
                if (isConnected && hasValidCreds && this.saveCreds) {
                    // Força salvamento para garantir que credenciais estão atualizadas
                    this.saveCreds();
                    this.lastCredSave = Date.now();
                }
                
                // Se não está conectado mas tem credenciais válidas, pode ser problema temporário
                // Não faz nada - o watchdog vai detectar e reconectar
            } catch (e) {
                // Ignora erros para não quebrar o sistema
                console.error('⚠️ Erro na validação de sessão (ignorado):', e.message);
            }
        }, 120000); // A cada 2 minutos
    }
    
    /**
     * HEALTH CHECK - Detecta quando bot para de receber/enviar mensagens (socket "zombie")
     * Detecta dois cenários:
     * 1. Bot recebe mensagens mas não consegue enviar (socket parcialmente funcional)
     * 2. Bot para completamente de receber/enviar (socket totalmente "zombie")
     */
    startHealthCheck() {
        // Limpa health check anterior se existir
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }
        
        this.healthCheckInterval = setInterval(() => {
            try {
                const now = Date.now();
                
                // Verifica se bot está "conectado" mas não está funcionando
                const isConnected = this.sock && 
                                   this.sock.ws && 
                                   this.sock.ws.readyState === 1 &&
                                   this.sock.user && 
                                   this.sock.user.id &&
                                   this.started;
                
                if (!isConnected) {
                    // Não está conectado - watchdog vai cuidar disso
                    return;
                }
                
                // Log periódico de status (a cada 10 minutos) para debug
                const timeSinceLastCheck = now - (this.lastHealthCheckLog || 0);
                if (timeSinceLastCheck > 10 * 60 * 1000) {
                    const timeSinceReceived = now - (this.lastReceivedMessageTime || 0);
                    const timeSinceSent = now - (this.lastSentMessageTime || 0);
                    console.log(`💚 [HEALTH CHECK] Status OK - Recebidas: ${Math.round(timeSinceReceived / 1000)}s | Enviadas: ${Math.round(timeSinceSent / 1000)}s | Falhas: ${this.failedSendAttempts}`);
                    this.lastHealthCheckLog = now;
                }
                
                const timeSinceLastReceived = now - (this.lastReceivedMessageTime || 0);
                const timeSinceLastSent = now - (this.lastSentMessageTime || 0);
                const hasRecentMessages = timeSinceLastReceived < 5 * 60 * 1000; // 5 minutos
                const noRecentSends = timeSinceLastSent > 5 * 60 * 1000; // Mais de 5 minutos sem enviar
                const hasFailedAttempts = this.failedSendAttempts >= this.maxFailedSendAttempts;
                
                // CENÁRIO 1: Bot recebe mensagens mas não consegue enviar
                const scenario1 = hasRecentMessages && (noRecentSends || hasFailedAttempts);
                
                // CENÁRIO 2: Bot para completamente de receber/enviar (socket totalmente "zombie")
                // Se não recebeu mensagens há mais de 15 minutos E não enviou há mais de 15 minutos
                // E está "conectado", provavelmente está zombie
                const noRecentReceives = timeSinceLastReceived > 15 * 60 * 1000; // Mais de 15 minutos sem receber
                const scenario2 = noRecentReceives && noRecentSends && isConnected;
                
                // Se detectou algum problema
                if (scenario1 || scenario2) {
                    // Não força reconexão se bot está explicitamente pausado
                    if (this.pauseRequested) {
                        return; // Bot está pausado intencionalmente
                    }
                    
                    console.log('');
                    console.log('═══════════════════════════════════════════════════════');
                    console.log('⚠️⚠️⚠️ [HEALTH CHECK] PROBLEMA DETECTADO: Socket "zombie" ⚠️⚠️⚠️');
                    console.log('═══════════════════════════════════════════════════════');
                    console.log(`   📥 Última mensagem recebida: ${Math.round(timeSinceLastReceived / 1000)}s atrás`);
                    console.log(`   📤 Última mensagem enviada: ${Math.round(timeSinceLastSent / 1000)}s atrás`);
                    console.log(`   ❌ Tentativas de envio falhadas: ${this.failedSendAttempts}`);
                    console.log('');
                    console.log('   🔍 DIAGNÓSTICO:');
                    
                    if (scenario1) {
                        console.log('   - Bot está recebendo mensagens ✅');
                        console.log('   - Bot NÃO consegue enviar respostas ❌');
                        console.log('   - Socket está parcialmente "zombie"');
                    } else if (scenario2) {
                        console.log('   - Bot PAROU de receber mensagens ❌');
                        console.log('   - Bot NÃO consegue enviar respostas ❌');
                        console.log('   - Socket está totalmente "zombie" (conectado mas morto)');
                    }
                    
                    console.log('   - Isso geralmente indica que a sessão expirou');
                    console.log('   - Socket aparece como "conectado" mas não funciona');
                    console.log('');
                    console.log('🔄 SOLUÇÃO: Forçando reconexão automática em 5 segundos...');
                    console.log('   (Você NÃO precisa reiniciar manualmente - o bot vai se recuperar sozinho)');
                    console.log('═══════════════════════════════════════════════════════');
                    console.log('');
                    
                    // Força reconexão
                    this.started = false;
                    this.pauseRequested = false;
                    this.failedSendAttempts = 0;
                    this.lastReceivedMessageTime = 0;
                    this.lastSentMessageTime = 0;
                    
                    // Limpa timeouts anteriores
                    if (this.forceReconnectTimeout) {
                        clearTimeout(this.forceReconnectTimeout);
                    }
                    
                    // Força reconexão após 5 segundos
                    this.forceReconnectTimeout = setTimeout(() => {
                        if (!this.started && !this.isRestarting && !this.pauseRequested) {
                            console.log('');
                            console.log('═══════════════════════════════════════════════════════');
                            console.log('🔄 [HEALTH CHECK] Iniciando reconexão automática...');
                            console.log('═══════════════════════════════════════════════════════');
                            this.start().then(() => {
                                console.log('');
                                console.log('✅ [HEALTH CHECK] Reconexão bem-sucedida! Bot está funcionando novamente.');
                                console.log('');
                            }).catch(err => {
                                console.error('');
                                console.error('❌ [HEALTH CHECK] Erro ao reconectar:', err.message);
                                console.error('🔄 Tentando novamente em 2 minutos...');
                                console.error('');
                                // Tenta novamente em 2 minutos se falhar
                                setTimeout(() => {
                                    if (!this.started && !this.isRestarting && !this.pauseRequested) {
                                        console.log('🔄 [HEALTH CHECK] Segunda tentativa de reconexão...');
                                        this.start().then(() => {
                                            console.log('✅ [HEALTH CHECK] Reconexão bem-sucedida na segunda tentativa!');
                                        }).catch(e => {
                                            console.error('❌ [HEALTH CHECK] Falha na segunda tentativa:', e.message);
                                            console.error('🔄 Continuando tentativas automáticas...');
                                        });
                                    }
                                }, 120000);
                            });
                        }
                    }, 5000);
                }
            } catch (e) {
                // Ignora erros para não quebrar o sistema
                console.error('⚠️ Erro no health check (ignorado):', e.message);
            }
        }, 60000); // Verifica a cada 1 minuto
    }
    
    /**
     * Para o health check (apenas se realmente necessário)
     */
    stopHealthCheck() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }
    
    /**
     * BACKUP DE CREDENCIAIS - Cria backup antes de limpar ou quando necessário
     */
    backupCredentials() {
        try {
            if (!fs.existsSync(this.authDir)) {
                return; // Não há nada para fazer backup
            }
            
            // Cria diretório de backup se não existir
            if (!fs.existsSync(this.credBackupDir)) {
                fs.mkdirSync(this.credBackupDir, { recursive: true });
            }
            
            // Cria backup com timestamp
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = path.join(this.credBackupDir, `backup-${timestamp}`);
            
            // Copia arquivos de autenticação
            const files = fs.readdirSync(this.authDir);
            fs.mkdirSync(backupPath, { recursive: true });
            
            for (const file of files) {
                const sourcePath = path.join(this.authDir, file);
                const destPath = path.join(backupPath, file);
                fs.copyFileSync(sourcePath, destPath);
            }
            
            // Mantém apenas os 5 backups mais recentes
            const backups = fs.readdirSync(this.credBackupDir)
                .map(name => ({
                    name,
                    path: path.join(this.credBackupDir, name),
                    time: fs.statSync(path.join(this.credBackupDir, name)).mtimeMs
                }))
                .sort((a, b) => b.time - a.time);
            
            // Remove backups antigos (mantém apenas 5)
            for (let i = 5; i < backups.length; i++) {
                fs.rmSync(backups[i].path, { recursive: true, force: true });
            }
            
        } catch (e) {
            console.error('⚠️ Erro ao criar backup de credenciais:', e.message);
        }
    }
    
    /**
     * RESTAURA BACKUP DE CREDENCIAIS - Restaura do backup mais recente
     */
    restoreCredentialsFromBackup() {
        try {
            if (!fs.existsSync(this.credBackupDir)) {
                return false; // Não há backups
            }
            
            const backups = fs.readdirSync(this.credBackupDir)
                .map(name => ({
                    name,
                    path: path.join(this.credBackupDir, name),
                    time: fs.statSync(path.join(this.credBackupDir, name)).mtimeMs
                }))
                .sort((a, b) => b.time - a.time);
            
            if (backups.length === 0) {
                return false; // Não há backups
            }
            
            // Restaura do backup mais recente
            const latestBackup = backups[0].path;
            
            // Limpa diretório atual
            if (fs.existsSync(this.authDir)) {
                fs.rmSync(this.authDir, { recursive: true, force: true });
            }
            fs.mkdirSync(this.authDir, { recursive: true });
            
            // Copia arquivos do backup
            const files = fs.readdirSync(latestBackup);
            for (const file of files) {
                const sourcePath = path.join(latestBackup, file);
                const destPath = path.join(this.authDir, file);
                fs.copyFileSync(sourcePath, destPath);
            }
            
            console.log('✅ Credenciais restauradas do backup:', latestBackup);
            return true;
        } catch (e) {
            console.error('❌ Erro ao restaurar backup:', e.message);
            return false;
        }
    }

    async handleConnectionUpdate(update) {
        const { connection, lastDisconnect, qr } = update;
        
        // Log detalhado quando há QR
        if (qr) {
            console.log(`🔍 [DEBUG] QR recebido! Tamanho: ${qr.length} caracteres`);
            this.qrString = qr;
            this.qrGeneratedTime = Date.now(); // Salva timestamp para detectar QR recente
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
            this.qrGeneratedTime = 0; // Limpa timestamp quando conecta
            
            // Reseta contadores quando conecta com sucesso
            this.reconnectAttempts = 0;
            this.disconnectCount = 0;
            this.lastConnectTime = Date.now();
            this.lastSuccessfulConnection = Date.now(); // ATUALIZA WATCHDOG - conexão bem-sucedida
            this.isRestarting = false; // Reseta flag de restart quando conecta
            this.lastConnectionError = null; // Limpa erro quando conecta
            this.pauseRequested = false; // Reseta pause quando conecta com sucesso
            
            // Reseta contadores do health check quando reconecta
            this.lastReceivedMessageTime = Date.now(); // Marca como se tivesse recebido agora (evita falso positivo)
            this.lastSentMessageTime = Date.now(); // Marca como se tivesse enviado agora (evita falso positivo)
            this.failedSendAttempts = 0; // Reseta contador de falhas
            if (this.restartTimeout) {
                clearTimeout(this.restartTimeout);
                this.restartTimeout = null;
            }
            
            // Conexão estabelecida - sempre mostra (crítico)
            if (this.sock?.user) {
                const userId = this.sock.user.id;
                const phoneNumber = userId.split(':')[0];
                this.log.connect(`✅ CONECTADO: ${phoneNumber} (${userId})`);
            }
            
            // Inicia keepalive manual para garantir conexão
            this.startKeepAlive();
        } else if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const errorMessage = lastDisconnect?.error?.message || 'Sem mensagem de erro';
            
            // CRÍTICO: Verifica se realmente está desconectado antes de marcar
            // Se ainda tem user.id, pode ser desconexão temporária - não marca como desconectado
            const hasUser = this.sock && this.sock.user && this.sock.user.id;
            
            if (!hasUser) {
                // Realmente desconectado - processa desconexão
                this.started = false;
                this.lastConnectionError = statusCode;
            } else {
                // Ainda tem user.id - pode ser reconexão automática ou erro temporário
                // Não marca como desconectado para evitar loops e QR codes desnecessários
                return; // Sai sem processar desconexão
            }

            // VERIFICA CÓDIGO 515 PRIMEIRO - Stream Errored (restart required)
            // Esse erro geralmente ocorre após escanear QR code e é temporário
            const isCode515 = (statusCode === 515);
            
            if (isCode515) {
                console.log(`⚠️ Código 515 detectado: Stream Errored (restart required)`);
                console.log(`💡 Isso geralmente acontece:`);
                console.log(`   - Logo após escanear o QR code`);
                console.log(`   - Durante processo de autenticação`);
                console.log(`   - WhatsApp precisa reiniciar o stream`);
                console.log(`\n🔄 Isso é NORMAL após escanear QR. Reconectando automaticamente...`);
                
                // Verifica se acabou de escanear QR (menos de 60 segundos)
                const timeSinceQr = this.qrString ? Date.now() - (this.qrGeneratedTime || 0) : Infinity;
                const justScannedQr = timeSinceQr < 60000; // 60 segundos
                
                if (justScannedQr) {
                    console.log(`✅ QR code escaneado recentemente. Aguardando 15 segundos para completar autenticação...`);
                    
                    // Aguarda mais tempo após escanear QR para completar autenticação
                    setTimeout(() => {
                        if (!this.started && !this.pauseRequested) {
                            console.log('🔄 Reconectando após erro 515 (QR escaneado)...');
                            this.reconnectAttempts = 0; // Reseta contador
                            this.start().catch(err => {
                                console.error('❌ Erro ao reconectar após 515:', err.message);
                                // Tenta novamente após 30 segundos
                                setTimeout(() => {
                                    if (!this.started && !this.pauseRequested) {
                                        console.log('🔄 Segunda tentativa após erro 515...');
                                        this.start().catch(e => {
                                            console.error('❌ Falha na segunda tentativa:', e.message);
                                            // Tenta mais uma vez após 1 minuto
                                            setTimeout(() => {
                                                if (!this.started && !this.pauseRequested) {
                                                    console.log('🔄 Terceira tentativa após erro 515...');
                                                    this.start().catch(finalErr => {
                                                        console.error('❌ Falha na terceira tentativa. Verifique conexão com internet.');
                                                    });
                                                }
                                            }, 60000);
                                        });
                                    }
                                }, 30000);
                            });
                        }
                    }, 15000); // Aguarda 15 segundos após escanear QR
                    
                    return;
                }
                
                // Se não foi QR recente, ainda tenta reconectar
                console.log(`🔄 Reconectando após erro 515 em 10 segundos...`);
                setTimeout(() => {
                    if (!this.started && !this.pauseRequested) {
                        console.log('🔄 Tentando reconectar após erro 515...');
                        this.reconnectAttempts = 0; // Reseta contador
                        this.start().catch(err => {
                            console.error('❌ Erro ao reconectar após 515:', err.message);
                            // Tenta novamente após 30 segundos
                            setTimeout(() => {
                                if (!this.started && !this.pauseRequested) {
                                    console.log('🔄 Segunda tentativa após erro 515...');
                                    this.start().catch(e => console.error('❌ Falha na segunda tentativa:', e.message));
                                }
                            }, 30000);
                        });
                    }
                }, 10000);
                
                return;
            }

            // VERIFICA CÓDIGO 428 - Connection Terminated by Server
            // MELHORADO: Só para se realmente houver múltiplas instâncias E não acabou de gerar QR
            const isCode428 = (statusCode === 428);
            
            if (isCode428) {
                // Se acabou de gerar QR code (menos de 30 segundos), erro 428 pode ser temporário
                // Não deve parar completamente - tenta reconectar
                const timeSinceQr = this.qrString ? Date.now() - (this.qrGeneratedTime || 0) : Infinity;
                const justGeneratedQr = timeSinceQr < 30000; // 30 segundos
                
                if (justGeneratedQr) {
                    console.log(`⚠️ Código 428 detectado logo após gerar QR code`);
                    console.log(`💡 Aguardando QR code ser escaneado. Não reconectando automaticamente...`);
                    console.log(`💡 Escaneie o QR code que foi gerado. O bot reconectará automaticamente após escanear.`);
                    
                    // NÃO reconecta imediatamente após gerar QR - aguarda ser escaneado
                    // O WhatsApp vai reconectar automaticamente quando o QR for escaneado
                    // Se reconectar muito rápido, vai gerar novo QR e entrar em loop
                    this.pauseRequested = false; // Permite reconexão quando QR for escaneado
                    
                    return;
                }
                
                // Se não acabou de gerar QR, pode ser múltiplas instâncias
                console.log(`⚠️ Código 428 detectado: CONEXÃO TERMINADA PELO SERVIDOR`);
                console.log(`💡 Possíveis causas:`);
                console.log(`   - Múltiplas instâncias usando a mesma sessão`);
                console.log(`   - Outro bot conectado com o mesmo número`);
                console.log(`   - Sessão sendo usada em outro lugar`);
                console.log(`   - Problema temporário do WhatsApp`);
                console.log(`\n📁 Diretório de autenticação atual: ${this.authDir}`);
                console.log(`\n🔄 Tentando reconectar automaticamente em 30 segundos...`);
                console.log(`💡 Se o problema persistir:`);
                console.log(`   1. Verifique se há outros bots rodando`);
                console.log(`   2. Certifique-se de que cada bot usa um diretório diferente`);
                console.log(`   3. Use: npm run start:bot1, npm run start:bot2, npm run start:bot3`);
                
                // MELHORADO: Tenta reconectar automaticamente mesmo com erro 428
                // Só para se realmente houver múltiplas tentativas falhando
                setTimeout(() => {
                    if (!this.started && !this.pauseRequested) {
                        console.log('🔄 Tentando reconectar após erro 428...');
                        this.start().catch(err => {
                            console.error('❌ Erro ao reconectar após 428:', err.message);
                            // Se falhar novamente, tenta mais uma vez
                            setTimeout(() => {
                                if (!this.started && !this.pauseRequested) {
                                    console.log('🔄 Segunda tentativa após erro 428...');
                                    this.start().catch(e => {
                                        console.error('❌ Falha na segunda tentativa. Verifique se há múltiplas instâncias.');
                                        // Só para completamente após 2 tentativas falharem
                                        this.pauseRequested = true;
                                    });
                                }
                            }, 60000);
                        });
                    }
                }, 30000);
                
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
                    console.log(`\n🔄 Limpando tokens e tentando reconectar automaticamente...`);
                    console.log(`💡 Isso geralmente resolve o problema de sessão substituída`);
                    
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
                    
                    // MELHORADO: Limpa tokens e reconecta automaticamente após erro 440 (conflict/replaced)
                    // Erro 440 com conflict/replaced geralmente significa que precisa limpar tokens
                    // Limpa tokens IMEDIATAMENTE e reconecta
                    (async () => {
                        try {
                            await this.cleanupAuthDir();
                            this.reconnectAttempts = 0;
                            this.disconnectCount = 0;
                            this.lastDisconnectTime = 0;
                            this.lastConnectTime = 0;
                            this.pauseRequested = false; // Permite reconexão
                            
                            console.log('✅ Tokens limpos. Aguardando 5 segundos antes de reconectar...');
                            await new Promise(resolve => setTimeout(resolve, 5000)); // Aguarda 5s
                            
                            if (!this.started && !this.pauseRequested) {
                                console.log('🔄 Reconectando após limpeza de tokens (erro 440)...');
                                this.start().catch(err => {
                                    console.error('❌ Erro ao reconectar após 440:', err.message);
                                    // Tenta novamente após 30 segundos
                                    setTimeout(() => {
                                        if (!this.started && !this.pauseRequested) {
                                            console.log('🔄 Segunda tentativa após erro 440...');
                                            this.start().catch(e => console.error('❌ Falha na segunda tentativa:', e.message));
                                        }
                                    }, 30000);
                                });
                            }
                        } catch (e) {
                            console.error('❌ Erro ao limpar tokens após 440:', e.message);
                            // Mesmo com erro, tenta reconectar após um tempo
                            setTimeout(() => {
                                if (!this.started && !this.pauseRequested) {
                                    this.pauseRequested = false;
                                    this.start().catch(err => console.error('❌ Erro ao reconectar após falha na limpeza:', err.message));
                                }
                            }, 10000);
                        }
                    })();
                    
                    return;
                } else {
                    // MELHORADO: Código 440 genérico também limpa tokens e reconecta automaticamente
                    console.log(`⚠️ Código 440 detectado (sessão fechada temporariamente).`);
                    console.log(`💡 Possíveis causas:`);
                    console.log(`   - Tokens inválidos ou expirados`);
                    console.log(`   - Problema de rede/conexão`);
                    console.log(`   - WhatsApp detectou atividade suspeita`);
                    console.log(`\n🔄 Limpando tokens e tentando reconectar automaticamente...`);
                    
                    // Limpa tokens e reconecta automaticamente
                    setTimeout(async () => {
                        try {
                            await this.cleanupAuthDir();
                            this.reconnectAttempts = 0;
                            this.disconnectCount = 0;
                            this.lastDisconnectTime = 0;
                            this.lastConnectTime = 0;
                            this.pauseRequested = false; // Permite reconexão
                            
                            console.log('🔄 Reconectando após limpeza de tokens (erro 440 genérico)...');
                            await new Promise(resolve => setTimeout(resolve, 5000)); // Aguarda 5s
                            
                            if (!this.started && !this.pauseRequested) {
                                this.start().catch(err => {
                                    console.error('❌ Erro ao reconectar após 440:', err.message);
                                    // Tenta novamente após 30 segundos
                                    setTimeout(() => {
                                        if (!this.started && !this.pauseRequested) {
                                            console.log('🔄 Segunda tentativa após erro 440...');
                                            this.start().catch(e => console.error('❌ Falha na segunda tentativa:', e.message));
                                        }
                                    }, 30000);
                                });
                            }
                        } catch (e) {
                            console.error('❌ Erro ao limpar tokens após 440:', e.message);
                        }
                    }, 3000);
                    
                    return;
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
            // Trata erro 500 (Internal Server Error) - geralmente indica sessão inválida ou problema temporário
            const isCode500 = (statusCode === 500);
            
            if (isCode500) {
                console.log('⚠️ Erro 500 detectado: Internal Server Error');
                console.log('💡 Isso geralmente indica:');
                console.log('   - Sessão inválida ou corrompida');
                console.log('   - Problema temporário nos servidores do WhatsApp');
                console.log('   - Tokens expirados ou inválidos');
                console.log('🧹 Limpando tokens para gerar novo QR e reconectar...');
                
                try {
                    await this.cleanupAuthDir();
                    this.authState = null; // Limpa referência
                    this.reconnectAttempts = 0;
                    this.disconnectCount = 0;
                    this.lastDisconnectTime = 0;
                    this.lastConnectTime = 0;
                    this.started = false; // Permite reconexão
                    
                    console.log('✅ Tokens limpos. Reconectando em 5 segundos...');
                    
                    // SEMPRE reconecta automaticamente após limpar tokens (não verifica pauseRequested)
                    setTimeout(() => {
                        console.log('🔄 Tentando reconectar após erro 500...');
                        this.pauseRequested = false; // Garante que pode reconectar
                        this.start().catch(err => {
                            console.error('❌ Erro ao reconectar após 500:', err.message);
                            // Tenta novamente após 30 segundos se falhar
                            setTimeout(() => {
                                if (!this.started) {
                                    console.log('🔄 Segunda tentativa de reconexão após erro 500...');
                                    this.pauseRequested = false; // Garante que pode reconectar
                                    this.start().catch(e => console.error('❌ Falha na segunda tentativa:', e.message));
                                }
                            }, 30000);
                        });
                    }, 5000);
                } catch (e) {
                    console.error('❌ Erro ao limpar tokens:', e.message);
                    // Mesmo com erro, tenta reconectar
                    setTimeout(() => {
                        if (!this.pauseRequested) {
                            this.start().catch(err => console.error('❌ Erro ao reconectar:', err.message));
                        }
                    }, 5000);
                }
                
                return;
            }
            
            const mustCleanSession = (
                statusCode === DisconnectReason.loggedOut ||
                statusCode === DisconnectReason.badSession
            );

            if (mustCleanSession) {
                console.log('🧹 Sessão Baileys inválida (código:', statusCode, '). Limpando tokens para gerar novo QR.');
                await this.cleanupAuthDir();
                this.reconnectAttempts = 0;
                this.disconnectCount = 0;
                this.lastDisconnectTime = 0;
                this.lastConnectTime = 0;
                
                // Reconecta automaticamente após limpar sessão inválida
                console.log('🔄 Reconectando em 5 segundos após limpeza de sessão...');
                setTimeout(() => {
                    if (!this.pauseRequested) {
                        this.start().catch(err => {
                            console.error('❌ Erro ao reconectar após limpeza:', err.message);
                            // Tenta novamente após 30 segundos
                            setTimeout(() => {
                                if (!this.pauseRequested && !this.started) {
                                    console.log('🔄 Segunda tentativa de reconexão...');
                                    this.start().catch(e => console.error('❌ Falha na segunda tentativa:', e.message));
                                }
                            }, 30000);
                        });
                    }
                }, 5000);
                
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
                        await this.cleanupAuthDir();
                        this.authState = null; // Limpa referência
                        console.log(`✅ Tokens limpos. Próxima tentativa gerará novo QR code.`);
                    } catch (e) {
                        console.log(`⚠️ Erro ao limpar tokens:`, e.message);
                    }
                }
                
                console.log(`\n${'='.repeat(60)}`);
                console.log(`⏸️ Erro 405 detectado - Aguardando 2 horas antes de tentar novamente`);
                console.log(`${'='.repeat(60)}`);
                console.log(`\n💡 O watchdog vai reconectar automaticamente após 2 horas`);
                console.log(`💡 Isso evita bloqueio permanente do WhatsApp`);
                console.log(`\n⚠️ IMPORTANTE:`);
                console.log(`   - QR code NÃO será gerado enquanto houver erro 405!`);
                console.log(`   - O bot precisa conseguir conectar aos servidores primeiro`);
                console.log(`   - Aguardando 2 horas para evitar bloqueio`);
                console.log(`\n${'='.repeat(60)}\n`);
                
                // MELHORADO: Não para completamente - apenas aguarda mais tempo
                // O watchdog vai detectar e reconectar automaticamente após 2 horas
                this.pauseRequested = false; // Permite que watchdog reconecte
                this.isRestarting = false;
                
                // Cancela qualquer restart pendente
                if (this.restartTimeout) {
                    clearTimeout(this.restartTimeout);
                    this.restartTimeout = null;
                }
                
                // Fecha socket temporariamente
                try {
                    if (this.sock) {
                        this.sock.end();
                        this.sock = null;
                    }
                } catch (e) {
                    // Ignora erros
                }
                
                // Para keepalive temporariamente (será reiniciado quando reconectar)
                if (this.keepAliveInterval) {
                    clearInterval(this.keepAliveInterval);
                    this.keepAliveInterval = null;
                }
                
                // Marca timestamp para watchdog reconectar após 2 horas (em vez de 5 minutos)
                // Isso faz o watchdog aguardar 2 horas antes de tentar reconectar
                const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
                this.lastSuccessfulConnection = twoHoursAgo;
                // O watchdog vai detectar que passou mais de 5 minutos e reconectar
                // Mas como marcamos 2 horas atrás, vai aguardar até completar 2 horas
                
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
                        console.log(`⏸️ Limite de tentativas de rede atingido. Aguardando 5 minutos antes de tentar novamente...`);
                        console.log(`💡 O watchdog vai reconectar automaticamente após 5 minutos.`);
                        console.log(`💡 Verifique sua conexão com internet.`);
                        // Não para completamente - apenas reseta contador e deixa watchdog reconectar
                        this.reconnectAttempts = 0;
                        this.pauseRequested = false; // Permite watchdog reconectar
                        // Marca timestamp para watchdog reconectar após 5 minutos
                        this.lastSuccessfulConnection = Date.now() - (this.maxTimeWithoutConnection - (5 * 60 * 1000));
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
                
                // Limite máximo de tentativas - mas não para completamente
                if (this.reconnectAttempts > this.maxReconnectAttempts) {
                    console.log(`⏸️ Limite de tentativas atingido (${this.reconnectAttempts}). Aguardando 5 minutos antes de tentar novamente...`);
                    console.log(`💡 O watchdog vai reconectar automaticamente após 5 minutos.`);
                    // Reseta contador e deixa watchdog reconectar
                    this.reconnectAttempts = 0;
                    this.pauseRequested = false; // Permite watchdog reconectar
                    // Marca timestamp para watchdog reconectar após 5 minutos
                    this.lastSuccessfulConnection = Date.now() - (this.maxTimeWithoutConnection - (5 * 60 * 1000));
                    return; // Aguarda watchdog reconectar
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
        // DESABILITADO: Keepalive estava causando reconexões desnecessárias
        // O watchdog já faz esse trabalho de forma mais confiável
        // Mantém apenas o envio de presence update quando conectado
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
        }
        
        // Apenas envia presence update periodicamente - não detecta desconexão
        // O watchdog faz a detecção de desconexão de forma mais confiável
        this.keepAliveInterval = setInterval(() => {
            try {
                // Só envia presence se realmente conectado
                const hasUser = this.sock && this.sock.user && this.sock.user.id;
                const hasWs = this.sock && this.sock.ws && this.sock.ws.readyState === 1;
                
                if (hasUser && hasWs && this.started) {
                    // Atualiza timestamp de conexão
                    this.lastSuccessfulConnection = Date.now();
                    
                    // Envia presence update para manter conexão viva
                    this.sock.sendPresenceUpdate('available').catch(() => {
                        // Erro não é crítico - ignora
                    });
                } else if (hasUser && this.started) {
                    // Se tem user.id mas não tem ws, ainda está conectado
                    // Apenas atualiza timestamp - não tenta enviar presence
                    this.lastSuccessfulConnection = Date.now();
                }
                // Se não tem user.id, não faz nada - watchdog vai detectar e reconectar
            } catch (e) {
                // Ignora erros
            }
        }, 60000); // A cada 60 segundos (reduzido para evitar overhead)
    }

    async cleanupAuthDir() {
        try {
            // MELHORADO: Cria backup ANTES de limpar
            console.log('💾 Criando backup de credenciais antes de limpar...');
            this.backupCredentials();
            
            // Aguarda um pouco para garantir que backup foi criado
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Remove diretório se existir
            if (fs.existsSync(this.authDir)) {
                fs.rmSync(this.authDir, { recursive: true, force: true });
                console.log('✅ Tokens limpos. Backup salvo em:', this.credBackupDir);
            }
            
            // CRÍTICO: Recria o diretório IMEDIATAMENTE após limpar
            // Isso deve ser feito ANTES de qualquer tentativa de usar o Baileys
            // O Baileys precisa do diretório para salvar credenciais
            fs.mkdirSync(this.authDir, { recursive: true });
            console.log('✅ Diretório de tokens recriado:', this.authDir);
            
            // Aguarda um pouco para garantir que diretório foi criado completamente
            await new Promise(resolve => setTimeout(resolve, 500));
            
        } catch (e) {
            console.error('⚠️ Erro ao limpar tokens Baileys:', e);
            
            // CRÍTICO: Garante que diretório existe mesmo se limpeza falhar
            try {
                if (!fs.existsSync(this.authDir)) {
                    fs.mkdirSync(this.authDir, { recursive: true });
                    console.log('✅ Diretório recriado após erro:', this.authDir);
                }
            } catch (mkdirErr) {
                console.error('❌ Erro crítico ao recriar diretório:', mkdirErr.message);
            }
            
            // Tenta restaurar do backup se limpeza falhou parcialmente
            try {
                if (fs.existsSync(this.authDir) && fs.readdirSync(this.authDir).length === 0) {
                    console.log('🔄 Tentando restaurar do backup...');
                    this.restoreCredentialsFromBackup();
                }
            } catch (restoreErr) {
                console.error('❌ Erro ao restaurar backup:', restoreErr.message);
            }
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
                
                // Atualiza timestamp da última mensagem recebida (para health check)
                this.lastReceivedMessageTime = Date.now();

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
        const sock = await this.ensureSocket();
        
        // Se ensureSocket retornou null, socket não está conectado
        if (!sock || !sock.user || !sock.user.id) {
            // Não lança erro - apenas retorna sem enviar
            // Isso evita quebrar o fluxo quando socket está conectando
            return null;
        }
        
        try {
            const result = await sock.sendMessage(jid, { text });
            this.recordOutgoingMessage(jid, text);
            this.recordResponse(chatId);
            // Atualiza timestamp da última mensagem enviada com sucesso (para health check)
            this.lastSentMessageTime = Date.now();
            this.failedSendAttempts = 0; // Reseta contador de falhas
            return result;
        } catch (err) {
            // Incrementa contador de tentativas falhadas
            this.failedSendAttempts++;
            
            // Se erro ao enviar, não quebra o fluxo
            // Apenas loga se for erro crítico
            if (!err.message?.includes('not connected') && !err.message?.includes('readyState')) {
                this.log.error('Erro ao enviar mensagem:', err.message);
            }
            
            // Se muitas tentativas falharam, pode ser que o socket esteja "zombie"
            if (this.failedSendAttempts >= this.maxFailedSendAttempts) {
                console.log(`⚠️ [HEALTH CHECK] ${this.failedSendAttempts} tentativas de envio falharam. Socket pode estar desconectado.`);
                // Força verificação de conexão no próximo health check
            }
            
            return null;
        }
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
        // Verifica se socket está conectado antes de enviar
        if (!this.sock || !this.sock.user || !this.sock.user.id) {
            return null; // Socket não conectado - não envia menu
        }
        
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

        return await this.sendText(chatId, menuMsg);
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
            return null; // Socket não inicializado
        }
        
        // CRÍTICO: Verifica se socket está realmente conectado
        // Se não tem user.id, não está conectado ainda
        if (!this.sock.user || !this.sock.user.id) {
            // Aguarda um pouco - pode estar conectando
            let attempts = 0;
            while (attempts < 5 && (!this.sock.user || !this.sock.user.id)) {
                await new Promise(resolve => setTimeout(resolve, 200));
                attempts++;
            }
            
            // Se ainda não conectou, retorna null
            if (!this.sock.user || !this.sock.user.id) {
                return null;
            }
        }
        
        // Verifica WebSocket apenas se existir (pode não existir em alguns casos)
        if (this.sock.ws && this.sock.ws.readyState !== undefined && this.sock.ws.readyState !== 1) {
            return null;
        }
        
        return this.sock;
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
            // AUMENTADO: 10 erros em 5 minutos (antes: 5 em 3 minutos)
            // Isso evita limpezas desnecessárias quando há erros esporádicos normais
            this.badMacErrorThreshold = 10;
            this.lastBadMacErrorTime = 0;
            this.badMacErrorWindow = 5 * 60 * 1000; // 5 minutos (antes: 3 minutos)
            this.lastBadMacLogTime = 0; // Timestamp do último log detalhado
            this.lastCleanupTime = 0; // Timestamp da última limpeza (evita loops)
            this.cleanupCooldown = 10 * 60 * 1000; // Cooldown de 10 minutos entre limpezas
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
            // MELHORADO: Só mostra erros Bad MAC quando realmente importante
            // Erros esporádicos são normais e não precisam aparecer nos logs
            const isNearThreshold = this.badMacErrorCount >= this.badMacErrorThreshold - 3;
            const isFirstError = this.badMacErrorCount === 1;
            const isEveryFifth = this.badMacErrorCount % 5 === 0;
            
            if (isFirstError || isNearThreshold || isEveryFifth) {
                if (isNearThreshold) {
                    console.error(`⚠️ ERRO Bad MAC: ${this.badMacErrorCount}/${this.badMacErrorThreshold} - Próximo de limpar sessão`);
                } else if (isFirstError) {
                    console.error(`⚠️ Erro Bad MAC detectado ${context} (${this.badMacErrorCount}/${this.badMacErrorThreshold})`);
                    console.error(`💡 Erros esporádicos são normais. Limpeza automática será acionada após ${this.badMacErrorThreshold - 1} erros adicionais em 5 minutos.`);
                } else {
                    // A cada 5 erros, mostra mensagem mais discreta
                    console.error(`⚠️ Erro Bad MAC: ${this.badMacErrorCount}/${this.badMacErrorThreshold} (esporádico - normal)`);
                }
                
                // Log detalhado apenas quando próximo do limite
                if (isNearThreshold) {
                    console.error('💡 Isso geralmente indica:');
                    console.error('   - Sessão corrompida ou tokens inválidos após alguns dias');
                    console.error('   - Múltiplas instâncias usando a mesma sessão');
                    console.error('   - Conflito entre diferentes versões do código');
                    console.error(`📁 Diretório de tokens: ${this.authDir}`);
                }
            }
        }
        
        // Se atingiu o limite de erros, limpa a sessão e reconecta
        // IMPORTANTE: Isso é feito de forma assíncrona e não bloqueia o bot
        if (this.badMacErrorCount >= this.badMacErrorThreshold) {
            // PROTEÇÃO: Evita limpezas em loop - só limpa se passou o cooldown
            const timeSinceLastCleanup = now - (this.lastCleanupTime || 0);
            if (timeSinceLastCleanup < this.cleanupCooldown) {
                const remainingCooldown = Math.round((this.cleanupCooldown - timeSinceLastCleanup) / 1000);
                console.error(`⏸️ Limpeza recente detectada. Aguardando ${remainingCooldown}s antes de nova limpeza...`);
                return; // Não faz nada se ainda está em cooldown
            }
            
            // CRÍTICO: Verifica se o bot está realmente com problemas
            // Se tem user.id, está conectado mesmo que ws tenha problemas
            // Erros Bad MAC esporádicos são normais e não requerem limpeza se o bot está operacional
            const isBotWorking = this.sock && this.started && this.sock.user && this.sock.user.id;
            
            console.error('');
            console.error('⚠️⚠️⚠️ LIMITE DE ERROS BAD MAC ATINGIDO ⚠️⚠️⚠️');
            const timeWindow = Math.round((now - (this.lastBadMacErrorTime - this.badMacErrorWindow)) / 1000);
            console.error(`   ${this.badMacErrorCount} erros em ${timeWindow} segundos`);
            
            // Se o bot está funcionando (socket conectado), apenas reduz o contador
            // Erros Bad MAC esporádicos são comuns e não indicam problema real se o bot está operacional
            if (isBotWorking) {
                console.error('💡 Bot está conectado e funcionando. Erros Bad MAC são esporádicos e normais.');
                console.error('🔄 Reduzindo contador - limpeza será feita apenas se conexão cair...');
                // Reduz contador significativamente (mantém apenas 30%) para evitar limpezas desnecessárias
                this.badMacErrorCount = Math.max(1, Math.floor(this.badMacErrorThreshold * 0.3));
                // Reseta parcialmente o tempo para dar mais margem
                this.lastBadMacErrorTime = now - (this.badMacErrorWindow * 0.5);
                return;
            }
            
            console.error('🔄 Limpando sessão corrompida e forçando reconexão...');
            console.error('💡 O bot continuará funcionando durante a limpeza!');
            console.error('');
            
            // Marca tempo da limpeza
            this.lastCleanupTime = now;
            
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
            // Só mostra mensagem de limpeza automática quando próximo do limite (últimos 3 erros)
            if (this.badMacErrorCount >= this.badMacErrorThreshold - 3) {
                console.error(`💡 Limpeza automática será acionada após ${this.badMacErrorThreshold - this.badMacErrorCount} erros adicionais`);
            }
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
            
            // Reseta contadores (mas mantém lastCleanupTime para cooldown)
            this.badMacErrorCount = 0;
            this.lastBadMacErrorTime = 0;
            this.reconnectAttempts = 0;
            // lastCleanupTime já foi setado antes da limpeza, não reseta aqui
            
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
            // Restaura stderr e stdout originais
            if (this.originalStderrWrite) {
                process.stderr.write = this.originalStderrWrite;
            }
            if (this.originalStdoutWrite) {
                process.stdout.write = this.originalStdoutWrite;
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
            
            // Para health check se estiver rodando
            this.stopHealthCheck();
            
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
            // NÃO para o watchdog - ele vai detectar desconexão e reconectar automaticamente
            // O watchdog continua rodando para garantir auto-recuperação
        }
    }
}

module.exports = BaileysBot;

