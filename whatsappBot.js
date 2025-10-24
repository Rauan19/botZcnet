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
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            }
        });

        // Estados dos usuários
        this.userStates = new Map();
        this.setupEventListeners();
    }

    setupEventListeners() {
        // QR Code para autenticação
        this.client.on('qr', (qr) => {
            // QR Code gerado
            qrcode.generate(qr, {small: true});
        });

        // Bot pronto
        this.client.on('ready', () => {
            // Bot conectado
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
            await this.handleMessage(message);
        });
    }

    async handleMessage(message) {
        try {
            const contact = await message.getContact();
            const chat = await message.getChat();
            
            // Ignora mensagens do próprio bot
            if (message.fromMe) return;

            const messageText = message.body.trim();
            const contactName = contact.name || contact.pushname || 'Usuário';
            const contactId = contact.id._serialized;

            // Comando de ajuda
            if (messageText.toLowerCase() === '!help' || messageText.toLowerCase() === '!ajuda') {
                await this.sendHelpMessage(chat);
                return;
            }

            // Comando !menu - Menu interativo
            if (messageText.toLowerCase() === '!menu') {
                await chat.sendMessage(`🤖 *Menu Principal - ZcNet*

*Escolha uma opção:*

📄 *Ver boleto* - Digite *boleto*
💬 *Falar com suporte* - Digite *suporte*
📅 *Agendar horário* - Digite *agendar*

💡 *Dica:* Digite a palavra-chave para acessar cada opção.`);
                return;
            }

            // Comando !lista - Menu em lista
            if (messageText.toLowerCase() === '!lista') {
                await chat.sendMessage(`🤖 *ZcNet - Menu Principal*

*Selecione uma opção:*

💳 *FINANCEIRO*
📄 *Ver boleto* - Digite *boleto*
💳 *Pagamentos pendentes* - Digite *pagamentos*

🆘 *SUPORTE*
💬 *Falar com suporte* - Digite *suporte*
📞 *Solicitar ligação* - Digite *ligacao*

💡 *Dica:* Digite a palavra-chave para acessar cada opção.`);
                return;
            }

            // Voltar ao menu principal
            if (messageText.toLowerCase() === 'menu' || messageText.toLowerCase() === 'voltar') {
                this.userStates.delete(contactId);
                await chat.sendMessage(`🤖 *Menu Principal - ZcNet*

*O que você gostaria de fazer?*

💳 *Pagamentos* - Digite *pagamentos*
📊 *Relatórios* - Digite *relatorios*
❓ *Ajuda* - Digite *ajuda*

💡 *Dica:* Digite a palavra-chave ou use os comandos:
• *!menu* - Menu interativo
• *!lista* - Menu em lista
• *!help* - Ajuda completa`);
                return;
            }

            // Tratamento de respostas por palavras-chave
            if (messageText.toLowerCase() === 'pagamentos' || messageText.toLowerCase() === 'pagar') {
                this.userStates.set(contactId, 'waiting_cpf');
                await chat.sendMessage(`💳 *Pagamentos ZcNet*

Para buscar seus pagamentos, me envie seu *CPF* (11 dígitos).

Exemplo: *12345678901*

💡 *Dica:* Digite apenas os números do CPF, sem pontos ou traços.

*Para voltar ao início, digite: oi*`);
                return;
            }

            if (messageText.toLowerCase() === 'relatorios' || messageText.toLowerCase() === 'relatório') {
                this.userStates.set(contactId, 'waiting_cpf_reports');
                await chat.sendMessage(`📊 *Meus Relatórios ZcNet*

Para ver seus relatórios de uso, me envie seu *CPF* (11 dígitos).

Exemplo: *12345678901*

💡 *Dica:* Digite apenas os números do CPF, sem pontos ou traços.

*Para voltar ao início, digite: oi*`);
                return;
            }

            if (messageText.toLowerCase() === 'ajuda' || messageText.toLowerCase() === 'help') {
                await this.sendHelpMessage(chat);
                return;
            }

            if (messageText.toLowerCase() === 'boleto') {
                this.userStates.set(contactId, 'waiting_cpf');
                await chat.sendMessage(`💳 *Ver Boleto ZcNet*

Para buscar seu boleto, me envie seu *CPF* (11 dígitos).

Exemplo: *12345678901*

💡 *Dica:* Digite apenas os números do CPF, sem pontos ou traços.

*Para voltar ao início, digite: oi*`);
                return;
            }

            if (messageText.toLowerCase() === 'suporte') {
                await chat.sendMessage(`🆘 *Suporte ZcNet*

Para falar com nosso suporte, entre em contato:

📞 *Telefone:* (11) 99999-9999
📧 *Email:* suporte@zcnet.com.br
🌐 *Site:* www.zcnet.com.br

⏰ *Horário de atendimento:*
Segunda a Sexta: 8h às 18h
Sábado: 8h às 12h

*Para voltar ao início, digite: oi*`);
                return;
            }

            if (messageText.toLowerCase() === 'agendar') {
                await chat.sendMessage(`📅 *Agendar Horário*

Para agendar um horário de atendimento:

📞 *Ligue:* (11) 99999-9999
📧 *Email:* agendamento@zcnet.com.br

⏰ *Horários disponíveis:*
Segunda a Sexta: 8h às 18h
Sábado: 8h às 12h

*Para voltar ao início, digite: oi*`);
                return;
            }

            if (messageText.toLowerCase() === 'ligacao') {
                await chat.sendMessage(`📞 *Solicitar Ligação*

Para solicitar uma ligação de nosso suporte:

📞 *Ligue:* (11) 99999-9999
📧 *Email:* suporte@zcnet.com.br

⏰ *Horário de atendimento:*
Segunda a Sexta: 8h às 18h
Sábado: 8h às 12h

*Para voltar ao início, digite: oi*`);
                return;
            }


            // Verifica estado do usuário
            const userState = this.userStates.get(contactId);

            if (!userState) {
                // Processa opções numéricas primeiro
                if (messageText === '1') {
                    await chat.sendMessage(`💳 *Pagamentos*

Para acessar seus boletos e PIX, preciso do seu CPF.

Digite seu CPF (apenas números):`);
                    this.userStates.set(contactId, 'waiting_cpf');
                    return;
                }

                if (messageText === '2') {
                    await chat.sendMessage(`❓ *Como usar o bot ZcNet*

*Como navegar:*

🤖 *Iniciar:* Digite "oi" para começar
💳 *Pagamentos:* Digite "1" e depois seu CPF
❓ *Ajuda:* Digite "2" para ver esta tela

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

                // Se não for opção numérica, mostra menu inicial
                await chat.sendMessage(`Olá! 👋

Sou o assistente virtual da *ZcNet*! 🌐

*O que você gostaria de fazer?*

*1* 💳 *Pagamentos* - Ver boletos e PIX
*2* ❓ *Dúvidas* - Como usar o bot

Digite o número da opção desejada:`);
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

💳 *Escolha a forma de pagamento:*

*1* 📄 Boleto Bancário
*2* 📱 PIX (Código Copia e Cola)

Digite o número da opção desejada:`);
                    } catch (error) {
                        this.userStates.delete(contactId);
                        await chat.sendMessage(`❌ Cliente não encontrado com este CPF.

Verifique se o CPF está correto e tente novamente.

*Para voltar ao início, digite: oi*`);
                    }
                } else {
                    await chat.sendMessage(`❌ CPF inválido.

Digite seu CPF com 11 dígitos (apenas números).

Exemplo: *12345678901*

*Para voltar ao início, digite: oi*`);
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
                    await chat.sendMessage(`❌ Opção inválida.

Digite *1* para Boleto ou *2* para PIX.

*Para voltar ao início, digite: oi*`);
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

*Para voltar ao início, digite: oi*`
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
            }
            
            // Envia dados do PIX
            if (pixCode) {
                const pixInfoMessage = `📱 *PIX Gerado com Sucesso!*

💰 *Valor:* R$ ${latestBill.valor || latestBill.valor_total || 'Não informado'}

💡 *Como pagar:*
1. Abra seu app bancário
2. Cole o código PIX
3. Confirme o pagamento

⏰ *Após o pagamento:*
Sua internet será liberada em até 5 minutos. Se não liberar, ligue e desligue o roteador.

⬇️ *Código copia e cola do PIX abaixo* ⬇️

🙏 *Deus abençoe seu dia!* ✨

*Para voltar ao início, digite: oi*`;

                await chat.sendMessage(pixInfoMessage);

                // Código PIX puro para facilitar a cópia
                await chat.sendMessage(pixCode);
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
📅 *Vencimento:* ${latestBill.data_vencimento || latestBill.vencimento || 'Não informado'}

💡 *Como pagar:*
1. Abra seu app bancário
2. Escaneie o QR Code
3. Confirme o pagamento

🙏 *Deus abençoe seu dia!* ✨

*Para voltar ao início, digite: oi*`
                    });
                } catch (error) {
                    await chat.sendMessage(`📱 *PIX Gerado com Sucesso!*

💰 *Valor:* R$ ${latestBill.valor || latestBill.valor_total || 'Não informado'}
📅 *Vencimento:* ${latestBill.data_vencimento || latestBill.vencimento || 'Não informado'}

📱 *QR Code PIX gerado com sucesso!*

💡 *Como pagar:*
1. Abra seu app bancário
2. Escaneie o QR Code
3. Confirme o pagamento

🙏 *Deus abençoe seu dia!* ✨

*Para voltar ao início, digite: oi*`);
                }
            } else {
                await chat.sendMessage(`❌ Erro ao gerar PIX.

Cliente encontrado, mas não foi possível extrair o código PIX da resposta da API.

*Dados recebidos:* ${JSON.stringify(pixData)}

*Para voltar ao início, digite: oi*`);
            }

        } catch (error) {
            let errorMessage = '❌ Erro ao gerar PIX.';
            
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

    async sendHelpMessage(chat) {
        const helpMessage = `🤖 *Assistente Virtual ZcNet* 🌐

*Como usar:*

1️⃣ *Método por Menu (Recomendado):*
   • Digite "oi" ou qualquer saudação
   • Escolha a opção desejada
   • Envie seu CPF (11 dígitos)
   • Receba as informações

2️⃣ *Método Direto:*
   • Envie seu CPF diretamente (11 dígitos)
   • Exemplo: 12345678901

3️⃣ *Comandos Especiais:*
   • Digite *!menu* para botões interativos
   • Digite *!lista* para menu em lista
   • Digite *!help* para esta ajuda

*Menu de opções:*
*1* 💳 Pagamentos (PIX/Boleto)
*2* 📊 Meus Relatórios
*3* ❓ Ajuda (esta mensagem)

*Funcionalidades:*
📄 *Boleto Bancário* - PDF para impressão
📱 *PIX* - Código copia e cola
📊 *Relatórios* - Uso de dados e acessos
🆘 *Suporte* - Contato direto
📅 *Agendamento* - Marcar horários

*Navegação:*
• Digite *menu* para voltar ao menu principal
• Digite *voltar* para voltar ao menu principal
• Digite *!menu* para botões interativos
• Digite *!lista* para menu em lista

💡 *Dicas:*
• Use apenas números no CPF (11 dígitos)
• PIX é mais rápido e prático
• Boleto pode ser pago em qualquer banco
• Funciona com qualquer saudação (oi, olá, bom dia, etc.)
• Use *!menu* e *!lista* para navegação mais fácil

🙏 *Deus abençoe seu dia!* ✨

📞 *Suporte ZcNet:* Entre em contato se houver problemas.

*Para voltar ao início, digite: oi*`;

        await chat.sendMessage(helpMessage);
    }

    async start() {
        try {
            await this.client.initialize();
        } catch (error) {
            // Erro silencioso para produção
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