const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const zcBillService = require('./services/zcBillService');
const zcClientService = require('./services/zcClientService');
const fs = require('fs');
const path = require('path');

class WhatsAppBot {
    constructor() {
        this.client = new Client({
            authStrategy: new LocalAuth({
                clientId: "whatsapp-boleto-bot"
            }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox', 
                    '--disable-setuid-sandbox',
                    '--disable-web-security',
                    '--disable-features=VizDisplayCompositor',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--no-first-run',
                    '--no-default-browser-check',
                    '--disable-default-apps',
                    '--disable-extensions',
                    '--disable-plugins',
                    '--disable-images',
                    '--disable-javascript',
                    '--disable-web-security',
                    '--disable-features=TranslateUI',
                    '--disable-ipc-flooding-protection'
                ]
            },
            // Desabilita marcação automática de mensagens como lidas
            markOnlineOnConnect: false,
            disableWelcome: true,
            // Configurações para não marcar mensagens como lidas
            webVersionCache: {
                type: 'remote',
                remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
            }
        });

        // Estados dos usuários
        this.userStates = new Map();
        this.setupEventListeners();
    }

    setupEventListeners() {
        // QR Code para autenticação
        this.client.on('qr', (qr) => {
            console.log('\n📱 ===== QR CODE PARA CONEXÃO =====');
            console.log('📱 Escaneie o QR Code abaixo com seu WhatsApp:');
            console.log('');
            qrcode.generate(qr, {small: true});
            console.log('');
            console.log('📱 ================================');
            console.log('📱 QR Code gerado! Escaneie com seu WhatsApp para conectar!');
            console.log('📱 ================================\n');
        });

        // Bot pronto
        this.client.on('ready', () => {
            console.log('✅ Bot WhatsApp conectado com sucesso!');
            
            // Desabilita marcação automática de mensagens como lidas
            this.client.pupPage.evaluate(() => {
                console.log('🔧 Iniciando bloqueio RADICAL de marcação de leitura...');
                
                // Função para bloquear todas as funções de leitura
                const blockReadFunctions = () => {
                    // Bloqueia todas as funções relacionadas a leitura
                    if (window.Store && window.Store.Msg) {
                        // Bloqueia markAsRead
                        window.Store.Msg.markAsRead = function() {
                            console.log('🚫 BLOQUEADO: markAsRead');
                            return Promise.resolve();
                        };
                        
                        // Bloqueia ack
                        window.Store.Msg.ack = function() {
                            console.log('🚫 BLOQUEADO: ack');
                            return Promise.resolve();
                        };
                        
                        // Bloqueia sendReadReceipt
                        if (window.Store.Msg.sendReadReceipt) {
                            window.Store.Msg.sendReadReceipt = function() {
                                console.log('🚫 BLOQUEADO: sendReadReceipt');
                                return Promise.resolve();
                            };
                        }
                        
                        // Bloqueia markAsReadIfNecessary
                        if (window.Store.Msg.markAsReadIfNecessary) {
                            window.Store.Msg.markAsReadIfNecessary = function() {
                                console.log('🚫 BLOQUEADO: markAsReadIfNecessary');
                                return Promise.resolve();
                            };
                        }
                        
                        // Bloqueia markAsReadIfNecessarySync
                        if (window.Store.Msg.markAsReadIfNecessarySync) {
                            window.Store.Msg.markAsReadIfNecessarySync = function() {
                                console.log('🚫 BLOQUEADO: markAsReadIfNecessarySync');
                                return Promise.resolve();
                            };
                        }
                    }
                    
                    // Bloqueia funções do Chat
                    if (window.Store && window.Store.Chat) {
                        window.Store.Chat.sendReadReceipt = function() {
                            console.log('🚫 BLOQUEADO: Chat.sendReadReceipt');
                            return Promise.resolve();
                        };
                        
                        if (window.Store.Chat.markAsRead) {
                            window.Store.Chat.markAsRead = function() {
                                console.log('🚫 BLOQUEADO: Chat.markAsRead');
                                return Promise.resolve();
                            };
                        }
                    }
                    
                    // Bloqueia funções do Conversation
                    if (window.Store && window.Store.Conversation) {
                        window.Store.Conversation.sendReadReceipt = function() {
                            console.log('🚫 BLOQUEADO: Conversation.sendReadReceipt');
                            return Promise.resolve();
                        };
                        
                        if (window.Store.Conversation.markAsRead) {
                            window.Store.Conversation.markAsRead = function() {
                                console.log('🚫 BLOQUEADO: Conversation.markAsRead');
                                return Promise.resolve();
                            };
                        }
                    }
                    
                    // Bloqueia funções do MsgInfo
                    if (window.Store && window.Store.MsgInfo) {
                        if (window.Store.MsgInfo.sendReadReceipt) {
                            window.Store.MsgInfo.sendReadReceipt = function() {
                                console.log('🚫 BLOQUEADO: MsgInfo.sendReadReceipt');
                                return Promise.resolve();
                            };
                        }
                    }
                    
                    // Bloqueia funções do WebMessageInfo
                    if (window.Store && window.Store.WebMessageInfo) {
                        if (window.Store.WebMessageInfo.markAsRead) {
                            window.Store.WebMessageInfo.markAsRead = function() {
                                console.log('🚫 BLOQUEADO: WebMessageInfo.markAsRead');
                                return Promise.resolve();
                            };
                        }
                    }
                };
                
                // Executa o bloqueio imediatamente
                blockReadFunctions();
                
                // Reaplica o bloqueio a cada 1 segundo
                setInterval(blockReadFunctions, 1000);
                
                // Intercepta todas as chamadas de fetch relacionadas a leitura
                const originalFetch = window.fetch;
                window.fetch = function(...args) {
                    const url = args[0];
                    if (typeof url === 'string' && (url.includes('read') || url.includes('ack') || url.includes('receipt'))) {
                        console.log('🚫 BLOQUEADO: fetch para leitura -', url);
                        return Promise.resolve(new Response('{}'));
                    }
                    return originalFetch.apply(this, args);
                };
                
                // Intercepta XMLHttpRequest
                const originalXHR = window.XMLHttpRequest;
                window.XMLHttpRequest = function() {
                    const xhr = new originalXHR();
                    const originalOpen = xhr.open;
                    xhr.open = function(method, url, ...args) {
                        if (typeof url === 'string' && (url.includes('read') || url.includes('ack') || url.includes('receipt'))) {
                            console.log('🚫 BLOQUEADO: XHR para leitura -', url);
                            return;
                        }
                        return originalOpen.apply(this, [method, url, ...args]);
                    };
                    return xhr;
                };
                
                console.log('✅ Bloqueio RADICAL de marcação de leitura ativado!');
            }).catch(error => {
                console.log('⚠️ Erro ao configurar bloqueio de leitura:', error.message);
            });
        });

        // Erro de autenticação
        this.client.on('auth_failure', msg => {
            // Erro silencioso para produção
        });

        // Desconectado
        this.client.on('disconnected', (reason) => {
            // Desconexão silenciosa para produção
        });

        // Mensagem recebida
        this.client.on('message', async (message) => {
            // Só responde se for mensagem de pagamento/boleto
            if (this.isPaymentRelated(message.body)) {
                await this.handleMessage(message);
            }
        });

        // Desabilita marcação automática de mensagens como lidas
        this.client.on('message_ack', (message, ack) => {
            // Intercepta e bloqueia confirmações de leitura
            console.log('🚫 Bloqueando confirmação de leitura para preservar contexto do atendente');
            return false; // Bloqueia a confirmação
        });

        // Intercepta e previne marcação de mensagens como lidas
        this.client.on('message_create', (message) => {
            // Não marca mensagens como lidas automaticamente
            console.log('🤖 Bot enviou mensagem sem marcar como lida');
            
            // Força o bloqueio de leitura após enviar mensagem
            setTimeout(() => {
                this.client.pupPage.evaluate(() => {
                    // Força o bloqueio novamente após cada mensagem
                    if (window.Store && window.Store.Msg) {
                        window.Store.Msg.markAsRead = function() {
                            console.log('🚫 BLOQUEADO APÓS ENVIO: markAsRead');
                            return Promise.resolve();
                        };
                    }
                }).catch(() => {});
            }, 100);
        });

        // Intercepta mudanças de status de mensagem
        this.client.on('message_revoke_everyone', (message) => {
            console.log('🚫 Bloqueando revogação de mensagem');
            return false;
        });

        // Intercepta mudanças de status de mensagem
        this.client.on('message_revoke_me', (message) => {
            console.log('🚫 Bloqueando revogação de mensagem');
            return false;
        });
    }

    /**
     * Verifica se a mensagem é relacionada a pagamento/boleto
     */
    isPaymentRelated(messageText) {
        if (!messageText) return false;
        
        const paymentKeywords = [
            'pagamento', 'boleto', 'pix', 'cobrança', 'fatura', 'conta',
            'pagar', 'vencimento', 'valor', 'dinheiro', 'transferência',
            'depósito', 'recibo', 'nota', 'comprovante', 'quitar',
            'saldo', 'devedor', 'em aberto', 'pendente', 'atrasado',
            '1', '2', '3' // Números do menu
        ];
        
        const message = messageText.toLowerCase();
        return paymentKeywords.some(keyword => message.includes(keyword));
    }

    /**
     * Verifica se é atendente humano (para pausar o bot)
     */
    isHumanAttendant(messageText) {
        if (!messageText) return false;
        
        const attendantKeywords = [
            'atendente humano', 'falar com atendente', 'quero atendente',
            'transferir para atendente', 'atendimento humano'
        ];
        
        const message = messageText.toLowerCase();
        
        // Se mensagem for muito longa (provavelmente humano)
        if (messageText.length > 200) return true;
        
        // Se contém frases específicas de atendente
        return attendantKeywords.some(keyword => message.includes(keyword));
    }

    /**
     * Verifica se o cliente mencionou que já pagou
     */
    isPaymentConfirmation(messageText) {
        if (!messageText) return false;
        
        console.log('🔍 Verificando confirmação de pagamento para:', messageText);
        
        const paymentConfirmationKeywords = [
            'já paguei', 'ja paguei', 'paguei', 'paguei já', 'já fiz o pagamento',
            'ja fiz o pagamento', 'fiz o pagamento', 'já paguei a conta', 'ja paguei a conta',
            'paguei a conta', 'já paguei a internet', 'ja paguei a internet', 'paguei a internet',
            'já paguei o boleto', 'ja paguei o boleto', 'paguei o boleto', 'já paguei o pix',
            'ja paguei o pix', 'paguei o pix', 'já transferi', 'ja transferi', 'transferi',
            'já depositei', 'ja depositei', 'depositei', 'já quitei', 'ja quitei', 'quitei',
            'já saldei', 'ja saldei', 'saldei', 'já resolvi', 'ja resolvi', 'resolvi',
            'já cancelei', 'ja cancelei', 'cancelei', 'já paguei tudo', 'ja paguei tudo',
            'paguei tudo', 'já paguei a fatura', 'ja paguei a fatura', 'paguei a fatura',
            'já paguei a cobrança', 'ja paguei a cobranca', 'paguei a cobrança', 'paguei a cobranca',
            'já efetuei o pagamento', 'ja efetuei o pagamento', 'efetuei o pagamento',
            'já realizei o pagamento', 'ja realizei o pagamento', 'realizei o pagamento',
            'já processei o pagamento', 'ja processei o pagamento', 'processei o pagamento',
            'já confirmei o pagamento', 'ja confirmei o pagamento', 'confirmei o pagamento',
            'já finalizei o pagamento', 'ja finalizei o pagamento', 'finalizei o pagamento',
            'já concluí o pagamento', 'ja conclui o pagamento', 'concluí o pagamento', 'conclui o pagamento',
            'já enviei o pagamento', 'ja enviei o pagamento', 'enviei o pagamento',
            'já mandei o pagamento', 'ja mandei o pagamento', 'mandei o pagamento',
            'já fiz a transferência', 'ja fiz a transferencia', 'fiz a transferência', 'fiz a transferencia',
            'já fiz o depósito', 'ja fiz o deposito', 'fiz o depósito', 'fiz o deposito',
            'já fiz o pix', 'ja fiz o pix', 'fiz o pix', 'já fiz o boleto', 'ja fiz o boleto', 'fiz o boleto',
            'já paguei online', 'ja paguei online', 'paguei online', 'já paguei pelo app', 'ja paguei pelo app',
            'paguei pelo app', 'já paguei pelo banco', 'ja paguei pelo banco', 'paguei pelo banco',
            'já paguei no banco', 'ja paguei no banco', 'paguei no banco', 'já paguei na lotérica',
            'ja paguei na loterica', 'paguei na lotérica', 'paguei na loterica',
            'já paguei no caixa', 'ja paguei no caixa', 'paguei no caixa', 'já paguei no terminal',
            'ja paguei no terminal', 'paguei no terminal', 'já paguei no caixa eletrônico',
            'ja paguei no caixa eletronico', 'paguei no caixa eletrônico', 'paguei no caixa eletronico',
            'já paguei no caixa automático', 'ja paguei no caixa automatico', 'paguei no caixa automático', 'paguei no caixa automatico',
            'já paguei via pix', 'ja paguei via pix', 'paguei via pix', 'já paguei via boleto',
            'ja paguei via boleto', 'paguei via boleto', 'já paguei via transferência',
            'ja paguei via transferencia', 'paguei via transferência', 'paguei via transferencia',
            'já paguei via depósito', 'ja paguei via deposito', 'paguei via depósito', 'paguei via deposito',
            'já paguei via débito', 'ja paguei via debito', 'paguei via débito', 'paguei via debito',
            'já paguei via crédito', 'ja paguei via credito', 'paguei via crédito', 'paguei via credito',
            'já paguei via cartão', 'ja paguei via cartao', 'paguei via cartão', 'paguei via cartao',
            'já paguei via dinheiro', 'ja paguei via dinheiro', 'paguei via dinheiro',
            'já paguei via dinheiro vivo', 'ja paguei via dinheiro vivo', 'paguei via dinheiro vivo',
            'já paguei em dinheiro', 'ja paguei em dinheiro', 'paguei em dinheiro',
            'já paguei com dinheiro', 'ja paguei com dinheiro', 'paguei com dinheiro',
            'já paguei em espécie', 'ja paguei em especie', 'paguei em espécie', 'paguei em especie',
            'já paguei em cash', 'ja paguei em cash', 'paguei em cash', 'já paguei em dinheiro',
            'ja paguei em dinheiro', 'paguei em dinheiro', 'já paguei em reais', 'ja paguei em reais',
            'paguei em reais', 'já paguei em real', 'ja paguei em real', 'paguei em real',
            'já paguei em dinheiro', 'ja paguei em dinheiro', 'paguei em dinheiro',
            'já paguei em espécie', 'ja paguei em especie', 'paguei em espécie', 'paguei em especie',
            'já paguei em cash', 'ja paguei em cash', 'paguei em cash', 'já paguei em dinheiro',
            'ja paguei em dinheiro', 'paguei em dinheiro', 'já paguei em reais', 'ja paguei em reais',
            'paguei em reais', 'já paguei em real', 'ja paguei em real', 'paguei em real'
        ];
        
        const message = messageText.toLowerCase();
        
        // Verifica se contém alguma palavra-chave de confirmação de pagamento
        const result = paymentConfirmationKeywords.some(keyword => message.includes(keyword));
        console.log('🔍 Resultado da verificação:', result);
        return result;
    }

    /**
     * Verifica se é mensagem automática do sistema
     */
    isSystemMessage(messageText) {
        if (!messageText) return false;
        
        const systemKeywords = [
            'código de confirmação', 'codigo de confirmacao', 'código de verificação', 'codigo de verificacao',
            'código de ativação', 'codigo de ativacao', 'código de acesso', 'codigo de acesso',
            'verification code', 'confirmation code', 'activation code', 'access code',
            'é seu código', 'e seu codigo', 'seu código', 'seu codigo',
            'código do', 'codigo do', 'código para', 'codigo para',
            'não compartilhe', 'nao compartilhe', 'não compartilhe este', 'nao compartilhe este',
            'do not share', 'don\'t share', 'não responda', 'nao responda',
            'do not reply', 'don\'t reply', 'não reenvie', 'nao reenvie',
            'do not forward', 'don\'t forward', 'sistema', 'system',
            'automático', 'automatico', 'automática', 'automatica',
            'notificação', 'notificacao', 'notification', 'alerta',
            'alert', 'aviso', 'warning', 'atenção', 'atencao',
            'importante', 'important', 'urgente', 'urgent',
            'código de segurança', 'codigo de seguranca', 'security code',
            'código de autenticação', 'codigo de autenticacao', 'authentication code',
            'código de login', 'codigo de login', 'login code',
            'código de acesso', 'codigo de acesso', 'access code',
            'código de recuperação', 'codigo de recuperacao', 'recovery code',
            'código de reset', 'codigo de reset', 'reset code',
            'código de senha', 'codigo de senha', 'password code',
            'código de PIN', 'codigo de PIN', 'PIN code',
            'código de OTP', 'codigo de OTP', 'OTP code',
            'código de 2FA', 'codigo de 2FA', '2FA code',
            'código de autenticação de dois fatores', 'codigo de autenticacao de dois fatores',
            'two-factor authentication code', '2FA authentication code',
            'código de verificação de dois fatores', 'codigo de verificacao de dois fatores',
            'two-factor verification code', '2FA verification code',
            'código de confirmação de dois fatores', 'codigo de confirmacao de dois fatores',
            'two-factor confirmation code', '2FA confirmation code',
            'código de ativação de dois fatores', 'codigo de ativacao de dois fatores',
            'two-factor activation code', '2FA activation code',
            'código de acesso de dois fatores', 'codigo de acesso de dois fatores',
            'two-factor access code', '2FA access code',
            'código de login de dois fatores', 'codigo de login de dois fatores',
            'two-factor login code', '2FA login code',
            'código de recuperação de dois fatores', 'codigo de recuperacao de dois fatores',
            'two-factor recovery code', '2FA recovery code',
            'código de reset de dois fatores', 'codigo de reset de dois fatores',
            'two-factor reset code', '2FA reset code',
            'código de senha de dois fatores', 'codigo de senha de dois fatores',
            'two-factor password code', '2FA password code',
            'código de PIN de dois fatores', 'codigo de PIN de dois fatores',
            'two-factor PIN code', '2FA PIN code',
            'código de OTP de dois fatores', 'codigo de OTP de dois fatores',
            'two-factor OTP code', '2FA OTP code'
        ];
        
        const message = messageText.toLowerCase();
        
        // Verifica se contém alguma palavra-chave de sistema
        return systemKeywords.some(keyword => message.includes(keyword));
    }

    /**
     * Envia mensagem sem marcar como lida
     */
    async sendMessageWithoutRead(chat, messageText) {
        try {
            // Envia a mensagem
            const sentMessage = await chat.sendMessage(messageText);
            
            // Força o bloqueio de leitura imediatamente após enviar
            setTimeout(() => {
                this.client.pupPage.evaluate(() => {
                    // Bloqueia todas as funções de leitura
                    if (window.Store && window.Store.Msg) {
                        window.Store.Msg.markAsRead = function() {
                            console.log('🚫 BLOQUEADO NO ENVIO: markAsRead');
                            return Promise.resolve();
                        };
                        window.Store.Msg.ack = function() {
                            console.log('🚫 BLOQUEADO NO ENVIO: ack');
                            return Promise.resolve();
                        };
                    }
                }).catch(() => {});
            }, 50);
            
            return sentMessage;
        } catch (error) {
            console.error('Erro ao enviar mensagem:', error);
            throw error;
        }
    }

    async handleMessage(message) {
        try {
            const contact = await message.getContact();
            const chat = await message.getChat();
            
            // Ignora mensagens do próprio bot
            if (message.fromMe) return;
            
            // Ignora mensagens de grupos - só responde em conversas privadas
            if (chat.isGroup) {
                console.log('🤖 Mensagem de grupo ignorada - bot só responde em conversas privadas');
                return;
            }

            // Ignora mensagens automáticas do sistema
            if (this.isSystemMessage(message.body)) {
                console.log('🤖 Mensagem automática ignorada - códigos de confirmação, notificações, etc.');
                return;
            }

            // Bloqueia marcação de mensagem como lida
            try {
                // Intercepta e cancela a marcação de leitura
                if (message.ack === 0) {
                    console.log('🚫 Bloqueando marcação de mensagem como lida');
                    // Não chama message.ack() para evitar marcar como lida
                }
            } catch (error) {
                // Erro silencioso
            }
            
            // Para se atendente humano responder (mensagens longas ou com "atendente", "suporte", etc.)
            if (this.isHumanAttendant(message.body)) {
                console.log('🤖 Bot pausado - Atendente humano assumiu a conversa');
                return;
            }

            // Verifica se cliente mencionou que já pagou
            console.log('🔍 Verificando mensagem:', message.body);
            if (this.isPaymentConfirmation(message.body)) {
                console.log('✅ Cliente confirmou pagamento - não oferecendo opções de pagamento');
                await this.sendMessageWithoutRead(chat, `✅ *PAGAMENTO CONFIRMADO!*
                
Obrigado por informar que já efetuou o pagamento! 🙏

⏰ *Sua internet será liberada em até 5 minutos.*
Se não liberar automaticamente, desligue e ligue os equipamentos.

🙏 *Deus abençoe seu dia!* ✨`);
                return;
            } else {
                console.log('❌ Mensagem não detectada como confirmação de pagamento');
            }

            const messageText = message.body.trim();
            const contactName = contact.name || contact.pushname || 'Usuário';
            const contactId = contact.id._serialized;

            // Comando INICIO - Voltar ao menu principal (funciona sempre, em qualquer momento)
            if (messageText.toLowerCase() === 'inicio' || messageText.toLowerCase() === 'menu' || messageText.toLowerCase() === 'voltar') {
                this.userStates.delete(contactId);
                await chat.sendMessage(`🤖 *MENU PRINCIPAL - ZCNET*

*O QUE VOCÊ GOSTARIA DE FAZER?*

💰 *PAGAMENTOS* - Digite *pagamentos*
❓ *DÚVIDAS* - Como usar o bot
🚪 *SAIR* - Encerrar atendimento

*DIGITE O NÚMERO DA OPÇÃO DESEJADA:*`);
                return;
            }

            // Comando de ajuda
            if (messageText.toLowerCase() === '!help' || messageText.toLowerCase() === '!ajuda') {
                await this.sendHelpMessage(chat);
                return;
            }

            // Comando !menu - Menu interativo
            if (messageText.toLowerCase() === '!menu') {
                await chat.sendMessage(`🤖 *MENU PRINCIPAL - ZCNET*

*ESCOLHA UMA OPÇÃO:*

📄 *VER BOLETO* - Digite *boleto*
💬 *FALAR COM SUPORTE* - Digite *suporte*
📅 *AGENDAR HORÁRIO* - Digite *agendar*

🚪 *SAIR DO ATENDIMENTO* - Digite *SAIR*

💡 *DICA:* Digite a palavra-chave para acessar cada opção.`);
                return;
            }

            // Comando !lista - Menu em lista
            if (messageText.toLowerCase() === '!lista') {
                await chat.sendMessage(`🤖 *ZCNET - MENU PRINCIPAL*

*SELECIONE UMA OPÇÃO:*

💰 *FINANCEIRO*
📄 *VER BOLETO* - Digite *boleto*
💰 *PAGAMENTOS PENDENTES* - Digite *pagamentos*

🆘 *SUPORTE*
💬 *FALAR COM SUPORTE* - Digite *suporte*
📞 *SOLICITAR LIGAÇÃO* - Digite *ligacao*

🚪 *SAIR DO ATENDIMENTO* - Digite *SAIR*

💡 *DICA:* Digite a palavra-chave para acessar cada opção.`);
                return;
            }


            // Tratamento de respostas por palavras-chave
            if (messageText.toLowerCase().includes('pagamentos') || messageText.toLowerCase().includes('pagar') || messageText.toLowerCase().includes('cobrança') || messageText.toLowerCase().includes('cobranca')) {
                this.userStates.set(contactId, 'waiting_cpf');
                await chat.sendMessage(`💰 *PAGAMENTOS ZCNET*

Para buscar seus pagamentos, me envie seu *CPF* (11 dígitos).

Exemplo: *12345678901*

💡 *DICA:* Digite apenas os números do CPF, sem pontos ou traços.

🚪 *SAIR DO ATENDIMENTO* - Digite *SAIR*

*PARA VOLTAR AO INÍCIO, DIGITE: INICIO*`);
                return;
            }

            if (messageText.toLowerCase().includes('relatorios') || messageText.toLowerCase().includes('relatório')) {
                this.userStates.set(contactId, 'waiting_cpf_reports');
                await chat.sendMessage(`📊 *MEUS RELATÓRIOS ZCNET*

Para ver seus relatórios de uso, me envie seu *CPF* (11 dígitos).

Exemplo: *12345678901*

💡 *DICA:* Digite apenas os números do CPF, sem pontos ou traços.

🚪 *SAIR DO ATENDIMENTO* - Digite *SAIR*

*PARA VOLTAR AO INÍCIO, DIGITE: INICIO*`);
                return;
            }

            if (messageText.toLowerCase().includes('ajuda') || messageText.toLowerCase().includes('help')) {
                await this.sendHelpMessage(chat);
                return;
            }

            // Comando SAIR
            if (messageText.toLowerCase().includes('sair')) {
                this.userStates.delete(contactId);
                await chat.sendMessage(`👋 *OBRIGADO POR USAR O ZCNET!*

*ATENDIMENTO FINALIZADO*

Se precisar de ajuda novamente, é só digitar *INICIO* ou *MENU*.

🙏 *DEUS ABENÇOE SEU DIA!* ✨`);
                return;
            }


            if (messageText.toLowerCase().includes('boleto') || messageText.toLowerCase().includes('fatura')) {
                this.userStates.set(contactId, 'waiting_cpf');
                await chat.sendMessage(`💰 *VER BOLETO ZCNET*

Para buscar seu boleto, me envie seu *CPF* (11 dígitos).

Exemplo: *12345678901*

💡 *DICA:* Digite apenas os números do CPF, sem pontos ou traços.

🚪 *SAIR DO ATENDIMENTO* - Digite *SAIR*

*PARA VOLTAR AO INÍCIO, DIGITE: INICIO*`);
                return;
            }

            if (messageText.toLowerCase().includes('pix') || messageText.toLowerCase().includes('internet')) {
                this.userStates.set(contactId, 'waiting_cpf');
                await chat.sendMessage(`📱 *PIX ZCNET*

Para gerar seu PIX, me envie seu *CPF* (11 dígitos).

Exemplo: *12345678901*

💡 *DICA:* Digite apenas os números do CPF, sem pontos ou traços.

🚪 *SAIR DO ATENDIMENTO* - Digite *SAIR*

*PARA VOLTAR AO INÍCIO, DIGITE: INICIO*`);
                return;
            }

            if (messageText.toLowerCase().includes('suporte')) {
                await chat.sendMessage(`🆘 *SUPORTE ZCNET*

Para falar com nosso suporte, entre em contato:

📞 *TELEFONE:* (11) 99999-9999
📧 *EMAIL:* suporte@zcnet.com.br
🌐 *SITE:* www.zcnet.com.br

⏰ *HORÁRIO DE ATENDIMENTO:*
Segunda a Sexta: 8h às 18h
Sábado: 8h às 12h

🚪 *SAIR DO ATENDIMENTO* - Digite *SAIR*

*PARA VOLTAR AO INÍCIO, DIGITE: INICIO*`);
                return;
            }

            if (messageText.toLowerCase().includes('agendar')) {
                await chat.sendMessage(`📅 *AGENDAR HORÁRIO*

Para agendar um horário de atendimento:

📞 *LIGUE:* (11) 99999-9999
📧 *EMAIL:* agendamento@zcnet.com.br

⏰ *HORÁRIOS DISPONÍVEIS:*
Segunda a Sexta: 8h às 18h
Sábado: 8h às 12h

🚪 *SAIR DO ATENDIMENTO* - Digite *SAIR*

*PARA VOLTAR AO INÍCIO, DIGITE: INICIO*`);
                return;
            }

            if (messageText.toLowerCase().includes('ligacao') || messageText.toLowerCase().includes('ligação')) {
                await chat.sendMessage(`📞 *SOLICITAR LIGAÇÃO*

Para solicitar uma ligação de nosso suporte:

📞 *LIGUE:* (11) 99999-9999
📧 *EMAIL:* suporte@zcnet.com.br

⏰ *HORÁRIO DE ATENDIMENTO:*
Segunda a Sexta: 8h às 18h
Sábado: 8h às 12h

🚪 *SAIR DO ATENDIMENTO* - Digite *SAIR*

*PARA VOLTAR AO INÍCIO, DIGITE: INICIO*`);
                return;
            }


            // Verifica estado do usuário
            const userState = this.userStates.get(contactId);

            if (!userState) {
                // Processa opções numéricas primeiro
                if (messageText === '1') {
                    await chat.sendMessage(`💰 *PAGAMENTOS*

Para acessar seus boletos e PIX, preciso do seu CPF.

*DIGITE SEU CPF (APENAS NÚMEROS):*

🚪 *SAIR DO ATENDIMENTO* - Digite *SAIR*`);
                    this.userStates.set(contactId, 'waiting_cpf');
                    return;
                }

                if (messageText === '2') {
                    await chat.sendMessage(`❓ *COMO USAR O BOT ZCNET*

*COMO NAVEGAR:*

🤖 *INICIAR:* Digite "inicio" para começar
💰 *PAGAMENTOS:* Digite "1" e depois seu CPF
❓ *AJUDA:* Digite "2" para ver esta tela
🚪 *SAIR:* Digite "3" para encerrar

🚪 *SAIR DO ATENDIMENTO* - Digite *SAIR*

*Fluxo de pagamentos:*
1️⃣ Digite "1" para acessar pagamentos
2️⃣ Digite seu CPF (apenas números)
3️⃣ Escolha: "1" para Boleto ou "2" para PIX
4️⃣ Receba seu boleto ou código PIX

*Dicas importantes:*
• Use apenas números para CPF
• O bot funciona 24h por dia`);
                    return;
                }

                if (messageText === '3') {
                    await chat.sendMessage(`🚪 *ATENDIMENTO ENCERRADO*

Obrigado por usar o bot da *ZCNET*! 🌐

Se precisar de ajuda novamente, envie qualquer mensagem e o bot retornará.

🙏 *DEUS ABENÇOE SEU DIA!* ✨`);
                    return;
                }

                // Se não for opção numérica, mostra menu inicial
                await chat.sendMessage(`Olá! 👋

Sou o assistente virtual da *ZCNET*! 🌐

*O QUE VOCÊ GOSTARIA DE FAZER?*

*1* 💰 *PAGAMENTOS* - Ver boletos e PIX
*2* ❓ *DÚVIDAS* - Como usar o bot
*3* 🚪 *SAIR* - Encerrar atendimento

*DIGITE O NÚMERO DA OPÇÃO DESEJADA:*`);
                return;
            }


            if (userState === 'waiting_cpf') {
                // Usuário está esperando CPF
                const cpfMatch = messageText.match(/\b\d{11}\b/);
                if (cpfMatch) {
                    const cpf = cpfMatch[0];
                    this.userStates.set(contactId, { state: 'waiting_payment_choice', cpf: cpf });
                    
                    await chat.sendMessage(`🔍 Encontrando sua fatura para CPF: ${cpf}...
⏳ Aguarde um momento...`);

                    try {
                        const client = await zcClientService.getClientByCpf(cpf);
                        
                        await chat.sendMessage(`✅ *Cliente encontrado:*
📋 Nome: ${client.nome || 'Não informado'}

💰 *ESCOLHA A FORMA DE PAGAMENTO:*

*1* 📄 BOLETO BANCÁRIO
*2* 📱 PIX (CÓDIGO COPIA E COLA)

🚪 *SAIR DO ATENDIMENTO* - Digite *SAIR*

*DIGITE O NÚMERO DA OPÇÃO DESEJADA:*`);
                    } catch (error) {
                        this.userStates.delete(contactId);
                        await chat.sendMessage(`❌ *CLIENTE NÃO ENCONTRADO COM ESTE CPF*

Verifique se o CPF está correto e tente novamente.

🚪 *SAIR DO ATENDIMENTO* - Digite *SAIR*

*PARA VOLTAR AO INÍCIO, DIGITE: INICIO*`);
                    }
                } else {
                    await chat.sendMessage(`❌ *CPF INVÁLIDO*

*DIGITE SEU CPF COM 11 DÍGITOS (APENAS NÚMEROS)*

Exemplo: *12345678901*

🚪 *SAIR DO ATENDIMENTO* - Digite *SAIR*

*PARA VOLTAR AO INÍCIO, DIGITE: INICIO*`);
                }
                return;
            }

            if (userState.state === 'waiting_payment_choice') {
                // Usuário está esperando escolha de pagamento
                if (messageText === '1') {
                    // Boleto
                    this.userStates.delete(contactId);
                    await this.generateBoleto(userState.cpf, chat);
                } else if (messageText === '2') {
                    // PIX
                    this.userStates.delete(contactId);
                    await this.generatePix(userState.cpf, chat);
                } else {
                    await chat.sendMessage(`❌ *OPÇÃO INVÁLIDA*

*DIGITE:*
*1* para BOLETO ou *2* para PIX

🚪 *SAIR DO ATENDIMENTO* - Digite *SAIR*

*PARA VOLTAR AO INÍCIO, DIGITE: INICIO*`);
                }
                return;
            }

        } catch (error) {
            try {
                await message.reply('❌ Ocorreu um erro interno. Tente novamente mais tarde.');
            } catch (replyError) {
                // Erro silencioso para produção
            }
        }
    }

    /**
     * Verifica se a mensagem é uma saudação
     * @param {string} messageText - Texto da mensagem
     * @returns {boolean}
     */
    // Função isGreeting removida - bot agora responde a qualquer mensagem

    async generateBoleto(cpf, chat) {
        try {
            await chat.sendMessage(`📄 *Gerando boleto bancário...*
⏳ Aguarde um momento...`);

            // Busca e gera o boleto
            const result = await zcBillService.getClientBillByCpf(cpf);
            
            // Verifica se o arquivo PDF existe
            if (fs.existsSync(result.pdfPath)) {
                // Envia o PDF
                const media = MessageMedia.fromFilePath(result.pdfPath);
                await chat.sendMessage(media, {
                    caption: `📄 *Boleto gerado com sucesso!*

Cliente: ${result.client.nome || 'Não informado'}
CPF: ${cpf}

💡 *Dica:* Salve este PDF no seu dispositivo para facilitar o pagamento.

🙏 *Deus abençoe seu dia!* ✨

*Para voltar ao início, digite: inicio*`
                });

                // Remove o arquivo após o envio
                setTimeout(() => {
                    try {
                        fs.unlinkSync(result.pdfPath);
                    } catch (error) {
                        // Erro silencioso
                    }
                }, 5000);

            } else {
                await chat.sendMessage(`❌ Erro ao gerar o PDF do boleto.

Cliente encontrado, mas não foi possível gerar o arquivo.
Tente novamente ou entre em contato com o suporte.`);
            }

        } catch (error) {
            let errorMessage = '❌ Erro ao gerar boleto.';
            
            if (error.message.includes('não encontrado')) {
                errorMessage = '❌ Cliente não encontrado com este CPF.';
            } else if (error.message.includes('serviços cadastrados')) {
                errorMessage = '❌ Cliente não possui serviços cadastrados.';
            } else if (error.message.includes('cobrança')) {
                errorMessage = '❌ Nenhuma cobrança encontrada para este serviço.';
            }
            
            errorMessage += '\n\nVerifique se o CPF está correto e tente novamente.';
            
            await chat.sendMessage(errorMessage);
        }
    }

    async generatePix(cpf, chat) {
        try {
            await chat.sendMessage(`📱 *Gerando PIX...*
⏳ Aguarde um momento...`);

            // Busca cliente e serviços
            const client = await zcClientService.getClientByCpf(cpf);
            const services = await zcClientService.getClientServices(client.id);
            
            if (!services || services.length === 0) {
                throw new Error('Cliente não possui serviços cadastrados');
            }

            const activeService = services.find(s => s.status === 'ativo') || services[0];
            
            // Busca cobranças
            const bills = await zcBillService.getBills(client.id, activeService.id);
            
            if (!bills || bills.length === 0) {
                throw new Error('Nenhuma cobrança encontrada para este serviço');
            }

            // Ordena por data de vencimento (mais recente primeiro)
            const sortedBills = bills.sort((a, b) => {
                const dateA = new Date(a.data_vencimento || a.vencimento);
                const dateB = new Date(b.data_vencimento || b.vencimento);
                return dateB - dateA;
            });

            const latestBill = sortedBills[0];

            // Gera QR Code PIX
            const pixData = await zcBillService.generatePixQRCode(client.id, activeService.id, latestBill.id);
            
            // Debug removido para produção
            
            // Verifica diferentes estruturas possíveis da resposta
            let pixCode = null;
            let qrCodeImage = null;
            
            // Verifica se tem código PIX no payload
            if (pixData && pixData.data && pixData.data.payload) {
                pixCode = pixData.data.payload;
            } else if (pixData && pixData.payload) {
                pixCode = pixData.payload;
            } else if (pixData && pixData.data && pixData.data.copia_cola) {
                pixCode = pixData.data.copia_cola;
            } else if (pixData && pixData.copia_cola) {
                pixCode = pixData.copia_cola;
            } else if (pixData && pixData.qrcode) {
                pixCode = pixData.qrcode;
            } else if (pixData && pixData.data && pixData.data.qrcode) {
                pixCode = pixData.data.qrcode;
            } else if (pixData && typeof pixData === 'string') {
                pixCode = pixData;
            }
            
            // Verifica se tem QR Code como imagem base64
            if (pixData && pixData.data && pixData.data.base64) {
                qrCodeImage = pixData.data.base64;
            } else if (pixData && pixData.base64) {
                qrCodeImage = pixData.base64;
            } else if (pixData && pixData.data && pixData.data.qrcode_image) {
                qrCodeImage = pixData.data.qrcode_image;
            } else if (pixData && pixData.qrcode_image) {
                qrCodeImage = pixData.qrcode_image;
            } else if (pixData && pixData.data && pixData.data.image) {
                qrCodeImage = pixData.data.image;
            } else if (pixData && pixData.image) {
                qrCodeImage = pixData.image;
            } else if (pixData && pixData.data && pixData.data.qr_code) {
                qrCodeImage = pixData.data.qr_code;
            } else if (pixData && pixData.qr_code) {
                qrCodeImage = pixData.qr_code;
            }
            
            // Debug removido para produção
            
            // Envia dados do PIX
            if (pixCode) {
                const pixInfoMessage = `📱 *PIX Gerado com Sucesso!*

💰 *Valor:* R$ ${latestBill.valor || latestBill.valor_total || 'Não informado'}

💡 *Como pagar:*
1. Abra seu app bancário
2. Cole o código PIX
3. Confirme o pagamento

⬇️ *Código copia e cola do PIX abaixo* ⬇️

🙏 *Deus abençoe seu dia!* ✨

*Para voltar ao início, digite: inicio*`;

                await chat.sendMessage(pixInfoMessage);

                // Envia instruções primeiro
                await chat.sendMessage(`📱 *Instruções para copiar:*
1. Toque e segure AO LADO da mensagem do código PIX (não em cima)
2. Selecione "Copiar" ou "Copy"
3. Abra seu app bancário
4. Cole o código PIX (remova "PIX: " se necessário)
5. Confirme o pagamento

⏰ *Após o pagamento:*
Sua internet será liberada em até 5 minutos. Se não liberar, desligue e ligue os equipamentos.`);

                // Envia código PIX sozinho em mensagem separada (sem link)
                // Envia código PIX normal
                await chat.sendMessage(pixCode);
                
                // Se tem QR Code como imagem, envia também
                if (qrCodeImage) {
                    try {
                        // Remove o prefixo "data:image/png;base64," se existir
                        let base64Data = qrCodeImage;
                        if (qrCodeImage.startsWith('data:image/png;base64,')) {
                            base64Data = qrCodeImage.replace('data:image/png;base64,', '');
                        }
                        
                        const media = MessageMedia.fromBase64(base64Data, 'image/png', 'qrcode.png');
                        await chat.sendMessage(media, {
                            caption: `📱 *QR Code PIX*
                            
📱 *Como pagar:*
1. Abra seu app bancário
2. Escaneie o QR Code
3. Confirme o pagamento`
                        });
                    } catch (error) {
                        // Se der erro, continua normalmente
                    }
                }
            } else if (qrCodeImage) {
                // Se tem QR Code como imagem, envia a imagem
                try {
                    // Remove o prefixo "data:image/png;base64," se existir
                    let base64Data = qrCodeImage;
                    if (qrCodeImage.startsWith('data:image/png;base64,')) {
                        base64Data = qrCodeImage.replace('data:image/png;base64,', '');
                    }
                    
                    const media = MessageMedia.fromBase64(base64Data, 'image/png', 'qrcode.png');
                    await chat.sendMessage(media, {
                        caption: `📱 *PIX Gerado com Sucesso!*

💰 *Valor:* R$ ${latestBill.valor || latestBill.valor_total || 'Não informado'}

📱 *Como pagar:*
1. Abra seu app bancário
2. Escaneie o QR Code
3. Confirme o pagamento

🙏 *Deus abençoe seu dia!* ✨

*Para voltar ao início, digite: inicio*`
                    });
                } catch (error) {
                    await chat.sendMessage(`📱 *PIX Gerado com Sucesso!*

💰 *Valor:* R$ ${latestBill.valor || latestBill.valor_total || 'Não informado'}
📅 *Vencimento:* ${latestBill.data_vencimento || latestBill.vencimento || 'Não informado'}

📱 *QR Code PIX gerado com sucesso!*

📱 *Como pagar:*
1. Abra seu app bancário
2. Escaneie o QR Code
3. Confirme o pagamento

🙏 *Deus abençoe seu dia!* ✨

*Para voltar ao início, digite: inicio*`);
                }
            } else {
                await chat.sendMessage(`❌ Erro ao gerar PIX.

Cliente encontrado, mas não foi possível extrair o código PIX da resposta da API.

*Dados recebidos:* ${JSON.stringify(pixData)}

*Para voltar ao início, digite: inicio*`);
            }

        } catch (error) {
            let errorMessage = '📱 Erro ao gerar PIX.';
            
            if (error.message.includes('não encontrado')) {
                errorMessage = '📱 Cliente não encontrado com este CPF.';
            } else if (error.message.includes('serviços cadastrados')) {
                errorMessage = '📱 Cliente não possui serviços cadastrados.';
            } else if (error.message.includes('cobrança')) {
                errorMessage = '📱 Nenhuma cobrança encontrada para este serviço.';
            }
            
            errorMessage += '\n\nVerifique se o CPF está correto e tente novamente.';
            
            await chat.sendMessage(errorMessage);
        }
    }

    async sendHelpMessage(chat) {
        const helpMessage = `🤖 *ASSISTENTE VIRTUAL ZCNET* 🌐

*COMO USAR:*

1️⃣ *MÉTODO POR MENU (RECOMENDADO):*
   • Digite "inicio" ou qualquer saudação
   • Escolha a opção desejada
   • Envie seu CPF (11 dígitos)
   • Receba as informações

2️⃣ *MÉTODO DIRETO:*
   • Envie seu CPF diretamente (11 dígitos)
   • Exemplo: 12345678901

3️⃣ *COMANDOS ESPECIAIS:*
   • Digite *!menu* para botões interativos
   • Digite *!lista* para menu em lista
   • Digite *!help* para esta ajuda

*MENU DE OPÇÕES:*
*1* 💰 PAGAMENTOS (PIX/BOLETO)
*2* 📊 MEUS RELATÓRIOS
*3* ❓ AJUDA (esta mensagem)

*FUNCIONALIDADES:*
📄 *BOLETO BANCÁRIO* - PDF para impressão
📱 *PIX* - Código copia e cola
📊 *RELATÓRIOS* - Uso de dados e acessos
🆘 *SUPORTE* - Contato direto

🚪 *SAIR DO ATENDIMENTO* - Digite *SAIR*
📅 *Agendamento* - Marcar horários

*Navegação:*
• Digite *menu* para voltar ao menu principal
• Digite *voltar* para voltar ao menu principal
• Digite *!menu* para botões interativos
• Digite *!lista* para menu em lista

💡 *Dicas:*
• Use apenas números no CPF (11 dígitos)
• 📱 PIX é mais rápido e prático
• Boleto pode ser pago em qualquer banco
• Funciona com qualquer saudação (inicio, olá, bom dia, etc.)
• Use *!menu* e *!lista* para navegação mais fácil

🙏 *Deus abençoe seu dia!* ✨

📞 *Suporte ZcNet:* Entre em contato se houver problemas.

*Para voltar ao início, digite: inicio*`;

        await chat.sendMessage(helpMessage);
    }

    async start() {
        try {
            console.log('🔄 Iniciando bot WhatsApp...');
            await this.client.initialize();
        } catch (error) {
            console.error('❌ Erro ao iniciar bot:', error);
        }
    }

    async stop() {
        try {
            await this.client.destroy();
        } catch (error) {
            // Erro silencioso para produção
        }
    }
}

module.exports = WhatsAppBot;