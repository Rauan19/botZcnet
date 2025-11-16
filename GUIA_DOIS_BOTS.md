# 🚀 Guia: Rodar Dois Bots na Mesma VPS

## 📋 O que precisa mudar para rodar dois bots simultaneamente

### 1. **PORTAS DIFERENTES** (obrigatório)
Cada bot precisa rodar em uma porta diferente do Express.

### 2. **DIRETÓRIOS DE TOKENS DIFERENTES** (obrigatório)
Cada bot precisa de sua própria pasta de tokens do WhatsApp.

### 3. **BANCO DE DADOS DIFERENTES** (obrigatório)
Cada bot precisa de seu próprio banco SQLite.

### 4. **VARIÁVEIS DE AMBIENTE** (recomendado)
Usar variáveis de ambiente para diferenciar os bots.

---

## 🔧 Configuração Passo a Passo

### **Opção 1: Dois Projetos Separados (Recomendado)**

#### Estrutura de Pastas:
```
/home/usuario/
├── bot-zcnet-1/          # Bot 1
│   ├── index.js
│   ├── baileysBot.js
│   ├── data/
│   │   └── app.db        # Banco do Bot 1
│   └── tokens-baileys-1/ # Tokens do Bot 1
│
└── bot-zcnet-2/          # Bot 2
    ├── index.js
    ├── baileysBot.js
    ├── data/
    │   └── app.db        # Banco do Bot 2
    └── tokens-baileys-2/ # Tokens do Bot 2
```

#### Modificações Necessárias:

**1. Bot 1 (`bot-zcnet-1/baileysBot.js`):**
```javascript
// Linha 29 - Mudar diretório de tokens
this.authDir = path.join(__dirname, 'tokens-baileys-1');
```

**2. Bot 1 (`bot-zcnet-1/index.js`):**
```javascript
// Linha 211 - Porta 3000
const PORT = process.env.PORT || 3000;
```

**3. Bot 2 (`bot-zcnet-2/baileysBot.js`):**
```javascript
// Linha 29 - Mudar diretório de tokens
this.authDir = path.join(__dirname, 'tokens-baileys-2');
```

**4. Bot 2 (`bot-zcnet-2/index.js`):**
```javascript
// Linha 211 - Porta 3001
const PORT = process.env.PORT || 3001;
```

**5. Bot 2 (`bot-zcnet-2/database.js`):**
```javascript
// Linha 5 - Banco diferente
const DB_PATH = path.join(__dirname, 'data', 'app-bot2.db');
```

---

### **Opção 2: Um Projeto com Variáveis de Ambiente (Mais Elegante)**

#### Modificações no Código:

**1. Modificar `baileysBot.js` (linha 29):**
```javascript
// ANTES:
this.authDir = path.join(__dirname, 'tokens-baileys');

// DEPOIS:
const BOT_ID = process.env.BOT_ID || 'bot1';
this.authDir = path.join(__dirname, `tokens-baileys-${BOT_ID}`);
```

**2. Modificar `database.js` (linha 5):**
```javascript
// ANTES:
const DB_PATH = path.join(__dirname, 'data', 'app.db');

// DEPOIS:
const BOT_ID = process.env.BOT_ID || 'bot1';
const DB_PATH = path.join(__dirname, 'data', `app-${BOT_ID}.db`);
```

**3. Modificar `index.js` (linha 211):**
```javascript
// Já está usando variável de ambiente:
const PORT = process.env.PORT || 3000;
```

---

## 🚀 Como Iniciar os Dois Bots

### **Usando PM2 (Recomendado para não cair na madrugada)**

#### 1. Instalar PM2:
```bash
npm install -g pm2
```

#### 2. Criar arquivo `ecosystem.config.js` na raiz:
```javascript
module.exports = {
  apps: [
    {
      name: 'bot-zcnet-1',
      script: './index.js',
      cwd: '/home/usuario/bot-zcnet-1',
      env: {
        PORT: 3000,
        BOT_ID: 'bot1',
        WHATSAPP_PROVIDER: 'baileys',
        NODE_ENV: 'production'
      },
      error_file: './logs/bot1-error.log',
      out_file: './logs/bot1-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      autorestart: true,
      max_memory_restart: '500M',
      watch: false,
      instances: 1
    },
    {
      name: 'bot-zcnet-2',
      script: './index.js',
      cwd: '/home/usuario/bot-zcnet-2',
      env: {
        PORT: 3001,
        BOT_ID: 'bot2',
        WHATSAPP_PROVIDER: 'baileys',
        NODE_ENV: 'production'
      },
      error_file: './logs/bot2-error.log',
      out_file: './logs/bot2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      autorestart: true,
      max_memory_restart: '500M',
      watch: false,
      instances: 1
    }
  ]
};
```

#### 3. Iniciar os bots:
```bash
# Se usar Opção 1 (dois projetos separados)
cd /home/usuario/bot-zcnet-1
pm2 start index.js --name bot-zcnet-1 --env PORT=3000

cd /home/usuario/bot-zcnet-2
pm2 start index.js --name bot-zcnet-2 --env PORT=3001

# OU se usar Opção 2 (um projeto com variáveis)
pm2 start ecosystem.config.js
```

#### 4. Configurar PM2 para iniciar automaticamente:
```bash
# Salvar configuração atual
pm2 save

# Configurar para iniciar no boot do sistema
pm2 startup
# Execute o comando que aparecer (algo como: sudo env PATH=... pm2 startup systemd -u usuario --hp /home/usuario)
```

#### 5. Comandos úteis do PM2:
```bash
# Ver status dos bots
pm2 status

# Ver logs em tempo real
pm2 logs

# Ver logs de um bot específico
pm2 logs bot-zcnet-1

# Reiniciar um bot
pm2 restart bot-zcnet-1

# Parar um bot
pm2 stop bot-zcnet-1

# Parar todos
pm2 stop all

# Reiniciar todos
pm2 restart all

# Monitorar recursos (CPU, memória)
pm2 monit
```

---

## 🔒 Garantir que não caia na madrugada

### **PM2 já resolve isso, mas configure:**

1. **Auto-restart:** Já configurado no PM2 (`autorestart: true`)
2. **Restart em caso de crash:** Automático
3. **Restart no boot do sistema:** `pm2 startup` (já feito acima)
4. **Monitoramento de memória:** `max_memory_restart: '500M'` (reinicia se passar de 500MB)

### **Monitoramento Adicional (Opcional):**

#### Criar script de monitoramento (`monitor.sh`):
```bash
#!/bin/bash
# Verifica se os bots estão rodando a cada 5 minutos

while true; do
    pm2 status | grep -q "bot-zcnet-1.*online"
    if [ $? -ne 0 ]; then
        echo "$(date): Bot 1 caiu! Reiniciando..."
        pm2 restart bot-zcnet-1
    fi
    
    pm2 status | grep -q "bot-zcnet-2.*online"
    if [ $? -ne 0 ]; then
        echo "$(date): Bot 2 caiu! Reiniciando..."
        pm2 restart bot-zcnet-2
    fi
    
    sleep 300  # Verifica a cada 5 minutos
done
```

#### Adicionar ao crontab:
```bash
# Editar crontab
crontab -e

# Adicionar linha (verifica a cada hora):
0 * * * * pm2 restart bot-zcnet-1 bot-zcnet-2
```

---

## 📊 Resumo das Portas e Diretórios

| Item | Bot 1 | Bot 2 |
|------|-------|-------|
| **Porta HTTP** | 3000 | 3001 |
| **Tokens** | `tokens-baileys-1/` | `tokens-baileys-2/` |
| **Banco de Dados** | `data/app.db` | `data/app-bot2.db` |
| **Logs PM2** | `logs/bot1-*.log` | `logs/bot2-*.log` |
| **Nome PM2** | `bot-zcnet-1` | `bot-zcnet-2` |

---

## ✅ Checklist Antes de Colocar em Produção

- [ ] Portas diferentes configuradas (3000 e 3001)
- [ ] Diretórios de tokens diferentes
- [ ] Bancos de dados diferentes
- [ ] PM2 instalado e configurado
- [ ] `pm2 startup` executado
- [ ] `pm2 save` executado
- [ ] Testar reinicialização: `pm2 restart all`
- [ ] Verificar logs: `pm2 logs`
- [ ] Verificar status: `pm2 status`
- [ ] Testar acesso aos painéis: `http://vps-ip:3000` e `http://vps-ip:3001`

---

## 🆘 Troubleshooting

### Bot não inicia:
```bash
# Ver logs detalhados
pm2 logs bot-zcnet-1 --lines 100

# Verificar se porta está em uso
netstat -tulpn | grep 3000
netstat -tulpn | grep 3001

# Matar processo na porta (se necessário)
sudo kill -9 $(lsof -t -i:3000)
```

### Bot cai frequentemente:
```bash
# Verificar memória
pm2 monit

# Verificar logs de erro
pm2 logs bot-zcnet-1 --err

# Aumentar limite de memória no ecosystem.config.js
max_memory_restart: '1G'
```

### PM2 não inicia no boot:
```bash
# Reconfigurar startup
pm2 unstartup
pm2 startup
# Executar o comando que aparecer
```

---

## 📝 Notas Importantes

1. **Baileys é mais estável** que whatsapp-web.js e não depende de browser, então é menos provável cair na madrugada.

2. **PM2 garante** que se o processo cair, ele reinicia automaticamente.

3. **Cada bot precisa** de seu próprio número de WhatsApp (não pode usar o mesmo número em dois bots).

4. **Backup regular** dos diretórios `tokens-baileys-*` e `data/` é recomendado.

5. **Monitorar logs** periodicamente para identificar problemas.

