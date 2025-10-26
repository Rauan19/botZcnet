const WhatsAppBot = require('./whatsappBot');
const zcBillService = require('./services/zcBillService');
const zcClientService = require('./services/zcClientService');

// Configuração de limpeza automática de arquivos PDF antigos
const CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutos

class App {
    constructor() {
        this.bot = new WhatsAppBot();
        this.setupGracefulShutdown();
        this.setupCleanup();
    }

    /**
     * Configura o encerramento graceful da aplicação
     */
    setupGracefulShutdown() {
        const shutdown = async (signal) => {
            // Encerrando aplicação
            
            try {
                await this.bot.stop();
                // Bot parado
                
                // Limpa arquivos temporários
                zcBillService.cleanupOldPDFs(0); // Remove todos os arquivos
                // Limpeza concluída
                
                process.exit(0);
            } catch (error) {
                
                process.exit(1);
            }
        };

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    }

    /**
     * Configura limpeza automática de arquivos PDF antigos
     */
    setupCleanup() {
        setInterval(() => {
            try {
                zcBillService.cleanupOldPDFs();
            } catch (error) {
                console.error('❌ Erro na limpeza automática:', error);
            }
        }, CLEANUP_INTERVAL);
    }

    /**
     * Inicia a aplicação
     */
    async start() {
        try {
          
            
            // Inicia o bot diretamente
            await this.bot.start();

        } catch (error) {
           
            process.exit(1);
        }
    }
}

// Inicia a aplicação
const app = new App();
app.start().catch(error => {
   
    process.exit(1);
});
