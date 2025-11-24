# 🚀 Guia: Rodar Múltiplas Instâncias do Bot

## 📋 Problema Resolvido

Antes, todas as instâncias usavam o mesmo diretório de autenticação (`tokens-baileys1`), causando conflitos quando múltiplos bots tentavam usar a mesma sessão do WhatsApp.

## ✅ Solução Implementada

Agora cada instância usa um diretório único baseado em:
1. **Variável de ambiente `BAILEYS_SESSION_ID`** (prioridade)
2. **Variável de ambiente `PORT`** (se BAILEYS_SESSION_ID não estiver definida)
3. **Fallback: `baileys1`** (se nenhuma das anteriores estiver definida)

## 🔧 Como Rodar Múltiplas Instâncias

### Opção 1: Usando PORT (Recomendado)

Cada instância usa a porta como identificador único:

```bash
# Bot 1 - Porta 3009
PORT=3009 npm run start:baileys

# Bot 2 - Porta 3010
PORT=3010 npm run start:baileys

# Bot 3 - Porta 3011
PORT=3011 npm run start:baileys
```

**Estrutura de pastas gerada:**
```
tokens-3009/  # Bot na porta 3009
tokens-3010/  # Bot na porta 3010
tokens-3011/  # Bot na porta 3011
```

### Opção 2: Usando BAILEYS_SESSION_ID

Para mais controle, use `BAILEYS_SESSION_ID`:

```bash
# Bot 1
BAILEYS_SESSION_ID=bot1 PORT=3009 npm run start:baileys

# Bot 2
BAILEYS_SESSION_ID=bot2 PORT=3010 npm run start:baileys

# Bot 3
BAILEYS_SESSION_ID=bot3 PORT=3011 npm run start:baileys
```

**Estrutura de pastas gerada:**
```
tokens-bot1/  # Bot 1
tokens-bot2/  # Bot 2
tokens-bot3/  # Bot 3
```

### Opção 3: Scripts no package.json (Windows PowerShell)

```powershell
# Bot 1
$env:PORT=3009; $env:BAILEYS_SESSION_ID="bot1"; npm run start:baileys

# Bot 2
$env:PORT=3010; $env:BAILEYS_SESSION_ID="bot2"; npm run start:baileys

# Bot 3
$env:PORT=3011; $env:BAILEYS_SESSION_ID="bot3"; npm run start:baileys
```

## 🖥️ Rodando na VPS (Linux)

### Usando PM2 (Recomendado)

```bash
# Instalar PM2 globalmente
npm install -g pm2

# Bot 1
pm2 start npm --name "bot1" -- run start:baileys -- --PORT=3009 --BAILEYS_SESSION_ID=bot1

# Bot 2
pm2 start npm --name "bot2" -- run start:baileys -- --PORT=3010 --BAILEYS_SESSION_ID=bot2

# Bot 3
pm2 start npm --name "bot3" -- run start:baileys -- --PORT=3011 --BAILEYS_SESSION_ID=bot3

# Ver status
pm2 status

# Ver logs
pm2 logs bot1
pm2 logs bot2
pm2 logs bot3

# Parar todos
pm2 stop all

# Reiniciar todos
pm2 restart all
```

### Usando arquivo ecosystem.config.js (Melhor para produção)

Crie um arquivo `ecosystem.config.js`:

```javascript
module.exports = {
  apps: [
    {
      name: 'bot1',
      script: 'index.js',
      env: {
        WHATSAPP_PROVIDER: 'baileys',
        PORT: 3009,
        BAILEYS_SESSION_ID: 'bot1'
      }
    },
    {
      name: 'bot2',
      script: 'index.js',
      env: {
        WHATSAPP_PROVIDER: 'baileys',
        PORT: 3010,
        BAILEYS_SESSION_ID: 'bot2'
      }
    },
    {
      name: 'bot3',
      script: 'index.js',
      env: {
        WHATSAPP_PROVIDER: 'baileys',
        PORT: 3011,
        BAILEYS_SESSION_ID: 'bot3'
      }
    }
  ]
};
```

Depois execute:
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # Para iniciar automaticamente no boot
```

## 📁 Estrutura de Pastas

Cada bot terá sua própria pasta de tokens:

```
botZcnet/
├── tokens-3009/     # Bot 1 (porta 3009)
├── tokens-3010/     # Bot 2 (porta 3010)
├── tokens-3011/     # Bot 3 (porta 3011)
├── data/            # Banco de dados compartilhado (opcional)
└── ...
```

## ⚠️ Importante

1. **Cada bot precisa escanear seu próprio QR code**
   - Bot 1: `http://seu-ip:3009/api/session/qr`
   - Bot 2: `http://seu-ip:3010/api/session/qr`
   - Bot 3: `http://seu-ip:3011/api/session/qr`

2. **Não compartilhe tokens entre instâncias**
   - Cada bot deve ter seu próprio diretório de tokens
   - Não copie tokens de um bot para outro

3. **Erro 428 (Connection Terminated by Server)**
   - Geralmente indica que múltiplas instâncias estão usando a mesma sessão
   - Verifique se cada bot tem seu próprio `BAILEYS_SESSION_ID` ou `PORT` diferente

4. **Erro 440 (Conflict/Replaced)**
   - Indica que a sessão foi substituída por outra conexão
   - Pode acontecer se o WhatsApp foi aberto em outro dispositivo
   - O bot limpará tokens automaticamente e gerará novo QR

## 🔍 Verificando se está funcionando

Ao iniciar cada bot, você verá no console:

```
📁 Diretório de autenticação: C:\...\botZcnet\tokens-3009
```

Isso confirma que cada bot está usando seu próprio diretório.

## 🐛 Troubleshooting

### Problema: Todos os bots ainda usam o mesmo diretório

**Solução:** Certifique-se de definir `PORT` ou `BAILEYS_SESSION_ID` antes de iniciar cada bot.

### Problema: Erro 428 continua aparecendo

**Solução:** 
1. Pare todos os bots
2. Verifique se não há processos antigos rodando: `Get-Process node` (Windows) ou `ps aux | grep node` (Linux)
3. Certifique-se de que cada bot tem um `PORT` ou `BAILEYS_SESSION_ID` diferente
4. Reinicie os bots

### Problema: Bot não conecta após escanear QR

**Solução:**
1. Verifique os logs do bot específico
2. Certifique-se de que o QR foi escaneado corretamente
3. Aguarde alguns segundos após escanear
4. Se persistir, limpe os tokens: `Remove-Item -Recurse -Force tokens-[PORT]` e reinicie

