# 📝 Arquivos e Linhas para Modificar - Dois Bots

## 🎯 ESTRUTURA: Criar Dois Projetos Separados

```
botZcnet/
├── bot-1/          ← Copiar projeto inteiro aqui
│   ├── baileysBot.js    ← MODIFICAR linha 29
│   ├── index.js         ← MODIFICAR linha 211
│   ├── database.js      ← MODIFICAR linha 5
│   └── ...
│
└── bot-2/          ← Copiar projeto inteiro aqui
    ├── baileysBot.js    ← MODIFICAR linha 29
    ├── index.js         ← MODIFICAR linha 211
    ├── database.js      ← MODIFICAR linha 5
    └── ...
```

---

## 📄 ARQUIVO 1: `baileysBot.js`

### **Bot 1** - Modificar linha 29:

**ANTES:**
```javascript
this.authDir = path.join(__dirname, 'tokens-baileys');
```

**DEPOIS:**
```javascript
this.authDir = path.join(__dirname, 'tokens-baileys-1');
```

---

### **Bot 2** - Modificar linha 29:

**ANTES:**
```javascript
this.authDir = path.join(__dirname, 'tokens-baileys');
```

**DEPOIS:**
```javascript
this.authDir = path.join(__dirname, 'tokens-baileys-2');
```

---

## 📄 ARQUIVO 2: `index.js`

### **Bot 1** - Modificar linha 211:

**ANTES:**
```javascript
const PORT = process.env.PORT || 3000;
```

**DEPOIS:**
```javascript
const PORT = process.env.PORT || 3000;  // Mantém 3000 para Bot 1
```

**OU se quiser garantir:**
```javascript
const PORT = 3000;  // Bot 1 sempre na porta 3000
```

---

### **Bot 2** - Modificar linha 211:

**ANTES:**
```javascript
const PORT = process.env.PORT || 3000;
```

**DEPOIS:**
```javascript
const PORT = process.env.PORT || 3001;  // Bot 2 na porta 3001
```

**OU se quiser garantir:**
```javascript
const PORT = 3001;  // Bot 2 sempre na porta 3001
```

---

## 📄 ARQUIVO 3: `database.js`

### **Bot 1** - Modificar linha 5:

**ANTES:**
```javascript
const DB_PATH = path.join(__dirname, 'data', 'app.db');
```

**DEPOIS:**
```javascript
const DB_PATH = path.join(__dirname, 'data', 'app-bot1.db');
```

---

### **Bot 2** - Modificar linha 5:

**ANTES:**
```javascript
const DB_PATH = path.join(__dirname, 'data', 'app.db');
```

**DEPOIS:**
```javascript
const DB_PATH = path.join(__dirname, 'data', 'app-bot2.db');
```

---

## ✅ RESUMO DAS MUDANÇAS

| Arquivo | Bot 1 | Bot 2 |
|---------|-------|-------|
| **baileysBot.js** (linha 29) | `tokens-baileys-1` | `tokens-baileys-2` |
| **index.js** (linha 211) | `3000` | `3001` |
| **database.js** (linha 5) | `app-bot1.db` | `app-bot2.db` |

---

## 🚀 PASSOS PARA IMPLEMENTAR

### 1. Criar estrutura de pastas:
```bash
cd /home/usuario
cp -r botZcnet bot-1
cp -r botZcnet bot-2
```

### 2. Modificar Bot 1:
```bash
cd bot-1

# Editar baileysBot.js linha 29
# Mudar: tokens-baileys → tokens-baileys-1

# Editar index.js linha 211  
# Mudar: PORT || 3000 → PORT || 3000 (ou só 3000)

# Editar database.js linha 5
# Mudar: app.db → app-bot1.db
```

### 3. Modificar Bot 2:
```bash
cd bot-2

# Editar baileysBot.js linha 29
# Mudar: tokens-baileys → tokens-baileys-2

# Editar index.js linha 211
# Mudar: PORT || 3000 → PORT || 3001 (ou só 3001)

# Editar database.js linha 5
# Mudar: app.db → app-bot2.db
```

### 4. Instalar dependências em cada bot:
```bash
cd bot-1
npm install

cd ../bot-2
npm install
```

### 5. Iniciar com PM2:
```bash
# Bot 1
cd bot-1
pm2 start index.js --name bot-zcnet-1

# Bot 2
cd bot-2
pm2 start index.js --name bot-zcnet-2

# Salvar configuração
pm2 save
```

---

## 📍 LOCALIZAÇÃO EXATA DAS LINHAS

### `baileysBot.js` - Linha 29:
```javascript
class BaileysBot {
    constructor() {
        this.sock = null;
        this.client = null;
        this.started = false;
        this.qrString = null;
        this.logger = P({
            level: process.env.BAILEYS_LOG_LEVEL || 'fatal',
            timestamp: () => `,"time":"${new Date().toISOString()}"`
        });
        this.authDir = path.join(__dirname, 'tokens-baileys'); // ← LINHA 29
```

### `index.js` - Linha 211:
```javascript
        async startDashboard() {
            const app = express();
            const PORT = process.env.PORT || 3000; // ← LINHA 211
            app.use(express.json());
```

### `database.js` - Linha 5:
```javascript
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'app.db'); // ← LINHA 5
const DB_DIR = path.dirname(DB_PATH);
```

---

## ⚠️ IMPORTANTE

1. **Cada bot precisa de seu próprio número de WhatsApp** (não pode usar o mesmo número)

2. **Cada bot terá seu próprio painel web:**
   - Bot 1: `http://seu-ip:3000`
   - Bot 2: `http://seu-ip:3001`

3. **Os diretórios serão criados automaticamente** quando os bots iniciarem:
   - `tokens-baileys-1/` (Bot 1)
   - `tokens-baileys-2/` (Bot 2)
   - `data/app-bot1.db` (Bot 1)
   - `data/app-bot2.db` (Bot 2)

4. **PM2 vai gerenciar ambos** e reiniciar automaticamente se cair

