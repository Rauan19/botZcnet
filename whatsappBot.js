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
                executablePath: '/usr/bin/chromium-browser', // <-- adicione isso
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process'
        ]
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
 whatsappBot.js        });

        // Bot pronto
        this.client.on('ready', () => {
            console.log('✅ Bot WhatsApp conectado com sucesso!');
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

    async handleMessage(message) {
        try {
            const contact = await message.getContact();
            const chat = await message.getChat();
            
            // Ignora mensagens do próprio bot
            if (message.fromMe) return;
            
            // Para se atendente humano responder (mensagens longas ou com "atendente", "suporte", etc.)
            if (this.isHumanAttendant(message.body)) {
                console.log('🤖 Bot pausado - Atendente humano assumiu a conversa');
                return;
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
