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
const fs = require('fs');

class WhatsAppBot {
    constructor() {
        this.client = null; // Instância do cliente wppconnect
        this.started = false;
        this.userStates = new Map(); // guarda último contexto por usuário (clientId, serviceId, billId)
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
                console.log('📥 onMessage bruto:', JSON.stringify({ from: message.from, isGroupMsg: message.isGroupMsg, body: message.body }));
                // Ignora grupos: bot atende só conversas privadas
                if (message.isGroupMsg) {
                    console.log('🤖 Mensagem de grupo ignorada (bot atende apenas conversas privadas).');
                    return;
                }

                // Direção da mensagem: se foi enviada pelo próprio número (atendente/WhatsApp), registra como "out"
                const body = message.body || '';
                const isFromMe = message.fromMe === true || message.sender?.isMe === true;
                if (isFromMe) {
                    // Mensagem enviada pelo nosso número; identificar o chat correto
                    const targetChatId = message.to || message.chatId || message.from;
                    try {
                        messageStore.recordOutgoingMessage({ chatId: targetChatId, text: body, timestamp: Date.now() });
                    } catch (_) {}
                    return; // não processa automações para mensagens nossas
                }

                console.log(`📩 Mensagem recebida de ${message.from}: ${body || '[sem texto]'}`);
                // Registrar no painel (incrementa não lidas)
                try { messageStore.recordIncomingMessage({ chatId: message.from, sender: message.from, text: body, timestamp: Date.now(), name: message.sender?.pushname || '' }); } catch (_) {}
                
                // Filtro de mensagens de sistema (evita responder códigos/confirm.
                if (this.isSystemMessage(body)) {
                    console.log('⚠️ Mensagem de sistema ignorada.');
                return;
            }

                // Se usuário afirma que já pagou, evitar menu de pagamento
                if (this.isPaymentConfirmation(body)) {
                    const outText = '✅ Pagamento confirmado. Obrigado! Se precisar de 2ª via futuramente, é só enviar seu CPF.';
                    await this.sendKeepingUnread(() => client.sendText(message.from, outText), message.from);
                    try { messageStore.recordOutgoingMessage({ chatId: message.from, text: outText }); } catch (_) {}
                return;
            }

                // Detecta CPF/documento (11+ dígitos) e envia boleto mais recente
                const doc = this.extractDocument(body);
                if (doc) {
                    const buscando = '*🔎 BUSCANDO SEU BOLETO MAIS RECENTE...*';
                    await this.sendKeepingUnread(() => client.sendText(message.from, buscando), message.from);
                    try { messageStore.recordOutgoingMessage({ chatId: message.from, text: buscando }); } catch (_) {}
                    try {
                        // Busca cliente e serviços
                        const cli = await zcClientService.getClientByDocument(doc);
                        const services = await zcClientService.getClientServices(cli.id);
                        if (!services || services.length === 0) {
                            const out = '*❌ CLIENTE ENCONTRADO MAS SEM SERVIÇOS ATIVOS*';
                            await client.sendText(message.from, out);
                            try { messageStore.recordOutgoingMessage({ chatId: message.from, text: out }); } catch (_) {}
                return;
            }
                        const activeService = services.find(s => s.status === 'ativo') || services[0];

                        // Busca contas e escolhe a mais recente
                        const bills = await zcBillService.getBills(cli.id, activeService.id, 'INTERNET');
                        if (!bills || bills.length === 0) {
                            const out = '*❌ NENHUMA COBRANÇA ENCONTRADA PARA ESTE CLIENTE*';
                            await client.sendText(message.from, out);
                            try { messageStore.recordOutgoingMessage({ chatId: message.from, text: out }); } catch (_) {}
                return;
            }
                        const latest = bills.sort((a, b) => new Date(b.data_vencimento || b.vencimento) - new Date(a.data_vencimento || a.vencimento))[0];

                        // Guarda contexto do usuário para PIX posterior
                        this.userStates.set(message.from, {
                            clientId: cli.id,
                            serviceId: activeService.id,
                            billId: latest.id,
                            clientName: cli?.nome || 'cliente'
                        });

                        // Gera PDF do boleto
                        const pdfPath = await zcBillService.generateBillPDF(cli.id, activeService.id, latest.id);
                            const caption = `*📄 BOLETO DE ${cli?.nome || 'cliente'}*\n\n*Se preferir PIX, responda: pix*`;
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
                                    text: '[arquivo] boleto.pdf - ' + caption,
                                    timestamp: Date.now(),
                                    fileId,
                                    fileName: 'boleto.pdf',
                                    fileType: 'application/pdf'
                                });
                            } catch (_) {
                                try { messageStore.recordOutgoingMessage({ chatId: message.from, text: '[arquivo] boleto.pdf - ' + caption, timestamp: Date.now() }); } catch (_) {}
                            }
                return;
                    } catch (e) {
                        console.error('Erro ao buscar boleto por documento:', e?.message || e);
                        const out = '*❌ NÃO ENCONTREI BOLETO*\n\nConfira o CPF (somente números) ou envie "*menu*".';
                        await this.sendKeepingUnread(() => client.sendText(message.from, out), message.from);
                        try { messageStore.recordOutgoingMessage({ chatId: message.from, text: out }); } catch (_) {}
                return;
            }
                }

                // Comandos simples e palavras-chave
                const text = body.trim().toLowerCase();
                
            // Detecta aviso de pagamento feito PRIMEIRO (em qualquer parte da mensagem)
            const pagamentoFeito = [
                'já paguei', 'ja paguei', 'já paguei', 'ja paguei',
                'paguei', 'paguei internet', 'paguei a internet',
                'fiz o pagamento', 'fiz pagamento', 'fiz o pagamento da internet',
                'realizei', 'realizei o pagamento', 'realizei pagamento',
                'efetuei', 'efetuei o pagamento', 'efetuei pagamento',
                'já fiz o pagamento', 'ja fiz o pagamento', 'já fiz', 'ja fiz',
                'cliente paguei', 'client paguei'
            ];
            
            if (pagamentoFeito.some(kw => text.includes(kw))) {
                const respostaPagamento = 
                    '✅ *PAGAMENTO CONFIRMADO!*\n\n' +
                    'Em até *5 MINUTOS* sua internet será liberada automaticamente.\n\n' +
                    '*Caso não retorne, desligue e ligue novamente os equipamentos.*';
                
                await this.sendKeepingUnread(() => client.sendText(message.from, respostaPagamento), message.from);
                try { messageStore.recordOutgoingMessage({ chatId: message.from, text: respostaPagamento }); } catch (_) {}
                return;
            }
            
            // Detecta palavras-chave de pagamento/boleto (excluindo as de confirmação)
            const keywords = [
                'pagar', 'pagamento', 'boleto', 'fatura', 'conta',
                'pix', 'segunda via', '2ª via',
                'internet', 'serviço', 'pago', 'vencimento', 'vencida'
            ];
            
            const hasKeyword = keywords.some(kw => text.includes(kw));
            
            if (!hasKeyword) {
                // Se não tiver palavra-chave, NÃO responde (ignora)
                console.log(`⚠️ Mensagem sem palavra-chave ignorada: "${text}"`);
                return;
            }
                
                // Responde apenas se tiver palavra-chave
                if (text === 'menu' || text.includes('menu')) {
                    const out = this.menuTexto();
                    await this.sendKeepingUnread(() => client.sendText(message.from, out), message.from);
                    try { messageStore.recordOutgoingMessage({ chatId: message.from, text: out }); } catch (_) {}
                    return;
                }
                
                if (text.includes('pix')) {
                    const ctx = this.userStates.get(message.from);
                    if (!ctx) {
                        const out = '*⚠️ ATENÇÃO*\n\nPara gerar PIX, envie primeiro seu *CPF* (somente números).';
                        await this.sendKeepingUnread(() => client.sendText(message.from, out), message.from);
                        try { messageStore.recordOutgoingMessage({ chatId: message.from, text: out }); } catch (_) {}
                        return;
                    }
                    try {
                        const preparando = '*🔧 GERANDO QRCODE PIX...*';
                        await this.sendKeepingUnread(() => client.sendText(message.from, preparando), message.from);
                        try { messageStore.recordOutgoingMessage({ chatId: message.from, text: preparando }); } catch (_) {}
                        const pix = await zcBillService.generatePixQRCode(ctx.clientId, ctx.serviceId, ctx.billId);
                        const parsed = this.parsePixPayload(pix);
                        
                        if (parsed.imageBase64) {
                            await this.sendKeepingUnread(() => client.sendImageFromBase64(message.from, parsed.imageBase64, 'pix.png', '*🔵 QRCODE PIX*\n\n*ESCANEIE PARA PAGAR VIA PIX*'), message.from);
                            try { messageStore.recordOutgoingMessage({ chatId: message.from, text: '[imagem] QRCode PIX' }); } catch (_) {}
                        }
                        if (parsed.payload) {
                            // Envia mensagem informativa primeiro
                            const infoMsg = '*🔗 COPIA E COLA PIX:*';
                            await this.sendKeepingUnread(() => client.sendText(message.from, infoMsg), message.from);
                            try { messageStore.recordOutgoingMessage({ chatId: message.from, text: infoMsg }); } catch (_) {}
                            
                            // Aguarda um pouco antes de enviar o código
                            await new Promise(resolve => setTimeout(resolve, 500));
                            
                            // Envia o código em outra mensagem
                            await this.sendKeepingUnread(() => client.sendText(message.from, parsed.payload), message.from);
                            try { messageStore.recordOutgoingMessage({ chatId: message.from, text: parsed.payload }); } catch (_) {}
                        }
                        if (!parsed.imageBase64 && !parsed.payload) {
                            const out = '*⚠️ ERRO*\n\nPIX gerado, mas não recebi imagem nem payload utilizável da API.';
                            await this.sendKeepingUnread(() => client.sendText(message.from, out), message.from);
                            try { messageStore.recordOutgoingMessage({ chatId: message.from, text: out }); } catch (_) {}
                        }
                        return;
                    } catch (e) {
                        console.error('Erro ao gerar PIX:', e?.message || e);
                        const out = '*❌ ERRO*\n\nNão consegui gerar o PIX agora. Tente novamente ou use o boleto em PDF.';
                        await this.sendKeepingUnread(() => client.sendText(message.from, out), message.from);
                        try { messageStore.recordOutgoingMessage({ chatId: message.from, text: out }); } catch (_) {}
                        return;
                    }
                }

                // Resposta padrão quando detecta palavra-chave mas não é comando específico
                const reply = '🤖 *OLÁ!*\n\nPara consultar seu boleto, envie seu *CPF* (apenas números).\n\nPara opções, envie "*menu*".';
                const sent = await this.sendKeepingUnread(() => client.sendText(message.from, reply), message.from);
                try { messageStore.recordOutgoingMessage({ chatId: message.from, text: reply }); } catch (_) {}
                console.log(`📤 Resposta enviada para ${message.from}. Id: ${sent && sent.id ? sent.id : 'n/d'}`);
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
                // Se mensagem foi enviada pelo próprio WhatsApp (atendente no celular/WhatsApp Web)
                if (m.fromMe === true && typeof m.body === 'string' && m.body.trim().length > 0) {
                    // Evita duplicidade com mensagens já gravadas pelo painel/bot
                    const targetChatId = m.chatId || m.to || m.from;
                    const exists = messageStore.hasSimilarRecentOutgoing(targetChatId, m.body.trim(), 7000);
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
        if (digits.length >= 11) return digits.slice(0, 14); // aceita CPF/CNPJ básicos
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
                        // Presence
                        if (window.Store.Presence) {
                            ['subscribe','subscribeAndWait','setPresenceAvailable','setMyPresence','sendPresenceAvailable','sendPresenceUnavailable']
                                .forEach((fn) => { if (typeof window.Store.Presence[fn] === 'function') window.Store.Presence[fn] = noop; });
                        }
                        if (window.Store.PresenceCollection) blockEventEmitter(window.Store.PresenceCollection);

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
                            if (/\b(read|readReceipts|sendSeen|markAsRead|presence|typing|composing)\b/i.test(url)) {
                                return Promise.resolve(new Response(null, { status: 204 }));
                            }
                        } catch {}
                        return origFetch(...args);
                    };

                    // XHR interceptor
                    const origOpen = XMLHttpRequest.prototype.open;
                    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                        try {
                            const s = String(url || '');
                            if (/\b(read|readReceipts|sendSeen|markAsRead|presence|typing|composing)\b/i.test(s)) {
                                this.send = () => undefined;
                                return;
                            }
                        } catch {}
                        return origOpen.call(this, method, url, ...rest);
                    };

                    // WebSocket interceptor
                    if (window.WebSocket) {
                        const _send = window.WebSocket.prototype.send;
                        window.WebSocket.prototype.send = function(data) {
                            try {
                                const payload = typeof data === 'string' ? data : (data?.toString?.() || '');
                                if (/\bread\b|\breadReceipts\b|\bmarkAsRead\b|\bsendSeen\b|\bpresence\b|\btyping\b|\bcomposing\b/i.test(payload)) {
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
}

module.exports = WhatsAppBot;


