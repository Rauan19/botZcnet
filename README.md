# 🤖 Bot WhatsApp ZcNet

Bot automatizado para WhatsApp com integração de pagamentos e cobrança via API ZcNet.

## 🚀 Funcionalidades

- **💳 Pagamentos** - Geração de boletos e PIX
- **📊 Relatórios** - Consulta de uso de dados
- **🆘 Suporte** - Informações de contato
- **📱 Menu Interativo** - Sistema de navegação por números

## 📋 Pré-requisitos

- Node.js (versão 16 ou superior)
- NPM ou Yarn
- Conta WhatsApp

## 🛠️ Instalação

1. Clone o repositório:
```bash
git clone <url-do-repositorio>
cd bootZcNe4t
```

2. Instale as dependências:
```bash
npm install
```

3. Configure as variáveis de ambiente no arquivo `config.js`

## 🚀 Como usar

1. Execute o bot:
```bash
node index.js
```

2. Escaneie o QR code com seu WhatsApp

3. Digite "oi" para começar

## 📱 Comandos

- **"oi"** - Inicia o bot
- **"1"** - Acessar pagamentos
- **"2"** - Ver relatórios  
- **"3"** - Suporte
- **"menu"** - Volta ao menu principal

## 🔧 Estrutura do Projeto

```
bootZcNe4t/
├── index.js              # Arquivo principal
├── whatsappBot.js        # Lógica do bot
├── services/             # APIs de integração
│   ├── zcAuthService.js  # Autenticação
│   ├── zcBillService.js  # Boletos e PIX
│   └── zcClientService.js # Clientes
├── config.js             # Configurações
├── temp/                 # Arquivos temporários
└── data/                 # Dados do bot
```

## 📝 Licença

Este projeto é privado e proprietário da ZcNet.

## 🆘 Suporte

Para suporte técnico, entre em contato com a equipe de desenvolvimento.