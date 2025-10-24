// Configurações da aplicação
module.exports = {
    // Configurações da API ZcNet
    zc: {
        baseUrl: 'https://zcnet.ispbox.com.br/api/v2',
        clientId: 'd435384d82e2ded84b686aeeebe55533',
        clientSecret: 'd25cea7919057ecd025513fad3e8eeba4c511aa349a098b3bebcb9238673e9e9',
        scope: 'clientes.ler clientes.servicos.ler clientes.servicos.status.atualizar clientes.servicos.internet.status clientes.servicos.internet.desconectar clientes.servicos.internet.filtro.mac.remover clientes.servicos.desbloqueio.temporario clientes.servicos.movel.consumo.ler clientes.servicos.cobrancas.ler clientes.servicos.cobrancas.pagamento.formas.ler clientes.servicos.cobrancas.pagamento.pdf.gerar clientes.servicos.cobrancas.pagamento.qrcode.gerar clientes.servicos.notas.fiscais.ler clientes.servicos.notas.fiscais.pdf.gerar clientes.servicos.relatorios.acessos.ler clientes.servicos.relatorios.franquia.dados.ler clientes.servicos.relatorios.grafico.banda.ler clientes.servicos.relatorios.ligacoes.ler clientes.servicos.relatorios.recargas.ler clientes.servicos.relatorios.portabilidades.ler',
        xRequestId: 'ispbox'
    },
    
    // Configurações do WhatsApp
    whatsapp: {
        sessionName: 'whatsapp-session'
    }
};


