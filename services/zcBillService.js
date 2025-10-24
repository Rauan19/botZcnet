const zcAuthService = require('./zcAuthService');
const fs = require('fs');
const path = require('path');

class ZcBillService {
    constructor() {
        this.billsDir = path.join(__dirname, '..', 'temp', 'boletos');
        this.ensureBillsDirectory();
    }

    /**
     * Garante que o diretório de boletos existe
     */
    ensureBillsDirectory() {
        if (!fs.existsSync(this.billsDir)) {
            fs.mkdirSync(this.billsDir, { recursive: true });
        }
    }

    /**
     * Lista cobranças de um serviço
     * @param {string} clientId - ID do cliente
     * @param {string} serviceId - ID do serviço
     * @returns {Promise<Array>} Lista de cobranças
     */
    async getBills(clientId, serviceId, tipoServico = 'INTERNET') {
        try {
            
            const response = await zcAuthService.makeAuthenticatedRequest(
                'GET',
                `/clientes/${clientId}/servicos/${serviceId}/cobrancas?tipoServico=${tipoServico}`
            );

            // Verifica se a resposta tem a estrutura correta
            if (response && response.data && Array.isArray(response.data)) {
                return response.data;
            } else if (Array.isArray(response)) {
                return response;
            } else {
                return [];
            }

        } catch (error) {
            console.error('❌ Erro ao buscar cobranças:', error.message);
            throw error;
        }
    }

    /**
     * Gera PDF do boleto
     * @param {string} clientId - ID do cliente
     * @param {string} serviceId - ID do serviço
     * @param {string} billId - ID da cobrança
     * @returns {Promise<string>} Caminho do arquivo PDF gerado
     */
    async generateBillPDF(clientId, serviceId, billId) {
        try {
            
            const response = await zcAuthService.makeAuthenticatedRequest(
                'GET',
                `/clientes/${clientId}/servicos/${serviceId}/cobrancas/${billId}/pagamento/pdf?formato=base64`
            );


            // Verifica diferentes estruturas possíveis da resposta
            let pdfData = null;
            
            if (response && response.data && response.data.pdf) {
                pdfData = response.data.pdf;
            } else if (response && response.data) {
                pdfData = response.data;
            } else if (response && response.pdf) {
                pdfData = response.pdf;
            } else if (response && response.boleto) {
                pdfData = response.boleto;
            } else if (typeof response === 'string') {
                pdfData = response;
            }

            if (pdfData) {
                // Remove o prefixo "data:application/pdf," se existir
                let base64Data = pdfData;
                if (typeof pdfData === 'string' && pdfData.startsWith('data:application/pdf,')) {
                    base64Data = pdfData.replace('data:application/pdf,', '');
                }
                
                const pdfBuffer = Buffer.from(base64Data, 'base64');
                const fileName = `boleto_${clientId}_${serviceId}_${billId}_${Date.now()}.pdf`;
                const filePath = path.join(this.billsDir, fileName);
                
                fs.writeFileSync(filePath, pdfBuffer);
                
                return filePath;
            } else {
                throw new Error('Resposta da API não contém dados do PDF válidos');
            }

        } catch (error) {
            console.error('❌ Erro ao gerar PDF do boleto:', error.message);
            throw error;
        }
    }

    /**
     * Gera QRCode PIX para pagamento
     * @param {string} clientId - ID do cliente
     * @param {string} serviceId - ID do serviço
     * @param {string} billId - ID da cobrança
     * @returns {Promise<object>} Dados do QRCode PIX
     */
    async generatePixQRCode(clientId, serviceId, billId) {
        try {
            
            const response = await zcAuthService.makeAuthenticatedRequest(
                'POST',
                `/clientes/${clientId}/servicos/${serviceId}/cobrancas/${billId}/pagamento/qrcode/gerar?tipo=PIX`
            );

            return response;

        } catch (error) {
            console.error('❌ Erro ao gerar QRCode PIX:', error.message);
            throw error;
        }
    }

    /**
     * Busca e gera PDF do boleto mais recente de um cliente
     * @param {string} clientId - ID do cliente
     * @param {string} serviceId - ID do serviço
     * @returns {Promise<string>} Caminho do arquivo PDF gerado
     */
    async getLatestBillPDF(clientId, serviceId, tipoServico = 'INTERNET') {
        try {
            // Busca as cobranças
            const bills = await this.getBills(clientId, serviceId, tipoServico);
            
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

            // Gera o PDF
            return await this.generateBillPDF(clientId, serviceId, latestBill.id);

        } catch (error) {
            console.error('❌ Erro ao obter boleto mais recente:', error.message);
            throw error;
        }
    }

    /**
     * Busca cliente por documento (CPF) e gera PDF do boleto mais recente
     * @param {string} documento - Documento (CPF) do cliente
     * @returns {Promise<object>} Dados do cliente e caminho do PDF
     */
    async getClientBillByDocument(documento) {
        try {
            const zcClientService = require('./zcClientService');
            
            // Busca cliente por documento
            const client = await zcClientService.getClientByDocument(documento);
            
            // Busca serviços do cliente
            const services = await zcClientService.getClientServices(client.id);
            
            if (!services || services.length === 0) {
                throw new Error('Cliente não possui serviços cadastrados');
            }

            // Usa o primeiro serviço ativo (pode ser melhorado para escolher o serviço correto)
            const activeService = services.find(s => s.status === 'ativo') || services[0];
            

            // Tenta diferentes tipos de serviço para encontrar cobranças
            const tiposServico = ['INTERNET', 'TELEFONE', 'TELEFONE_MOVEL'];
            let pdfPath = null;
            
            for (const tipoServico of tiposServico) {
                try {
                    pdfPath = await this.getLatestBillPDF(client.id, activeService.id, tipoServico);
                    break;
                } catch (error) {
                    // Continua tentando outros tipos
                }
            }
            
            if (!pdfPath) {
                throw new Error('Nenhuma cobrança encontrada para nenhum tipo de serviço');
            }

            return {
                client: client,
                service: activeService,
                pdfPath: pdfPath
            };

        } catch (error) {
            console.error('❌ Erro ao obter boleto do cliente:', error.message);
            throw error;
        }
    }

    /**
     * Busca cliente por CPF e gera PDF do boleto mais recente (método legado)
     * @param {string} cpf - CPF do cliente
     * @returns {Promise<object>} Dados do cliente e caminho do PDF
     */
    async getClientBillByCpf(cpf) {
        try {
            // Redireciona para o novo método usando documento
            return await this.getClientBillByDocument(cpf);
        } catch (error) {
            console.error('❌ Erro ao obter boleto do cliente:', error.message);
            throw error;
        }
    }

    /**
     * Remove arquivos PDF antigos (limpeza)
     * @param {number} maxAge - Idade máxima em milissegundos (padrão: 1 hora)
     */
    cleanupOldPDFs(maxAge = 3600000) {
        try {
            const files = fs.readdirSync(this.billsDir);
            const now = Date.now();
            
            files.forEach(file => {
                const filePath = path.join(this.billsDir, file);
                const stats = fs.statSync(filePath);
                
                if (now - stats.mtime.getTime() > maxAge) {
                    fs.unlinkSync(filePath);
                    // console.log(`🗑️ Arquivo antigo removido: ${file}`);
                }
            });
        } catch (error) {
            console.error('❌ Erro na limpeza de arquivos:', error.message);
        }
    }
}

module.exports = new ZcBillService();
