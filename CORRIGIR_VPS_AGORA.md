# 🚨 CORRIGIR VPS AGORA - Está Rodando via npm!

## ⚠️ Problema Identificado

Na VPS, o PM2 está rodando via **npm**, não Node direto:

```
Script path: /usr/bin/npm  ← ERRADO!
Heap Size: 9.98 MiB        ← Heap do npm, não do Node!
Heap Usage: 76.48%          ← Falso alarme!
```

## ✅ Solução Imediata

### **1. Parar e Remover Processo Atual:**

```bash
pm2 stop bot1
pm2 delete bot1
```

### **2. Limpar Logs:**

```bash
pm2 flush bot1
```

### **3. Iniciar CORRETAMENTE com Node Direto:**

```bash
pm2 start index.js --name bot1 \
  --node-args="--max-old-space-size=4096 --max-snapshots=1" \
  --env WHATSAPP_PROVIDER=baileys \
  --env PORT=3009 \
  --env BAILEYS_SESSION_ID=bot1 \
  --env BAILEYS_LOG_LEVEL=silent
```

### **4. Verificar se Está Correto:**

```bash
pm2 describe bot1 | grep -E "interpreter|node_args|script"
```

**Deve mostrar:**
```
interpreter: node          ← CORRETO!
node_args: --max-old-space-size=4096
script: index.js          ← CORRETO!
```

**NÃO deve mostrar:**
```
interpreter: npm           ← ERRADO!
script: /usr/bin/npm      ← ERRADO!
```

### **5. Verificar Heap Real:**

```bash
pm2 describe bot1 | grep -E "heap|memory"
```

**Agora deve mostrar:**
```
Heap Size: ~4096 MiB       ← CORRETO!
Heap Usage: <1%            ← CORRETO!
```

## 🎯 Forma Recomendada (Usando ecosystem.config.js)

Se você tem o arquivo `ecosystem.config.js` no servidor:

```bash
# Parar tudo
pm2 stop all
pm2 delete all

# Limpar logs
pm2 flush

# Iniciar corretamente
pm2 start ecosystem.config.js --only bot1

# Verificar
pm2 describe bot1 | grep -E "interpreter|script"
```

## 📊 Comparação

### **ANTES (ERRADO - via npm):**
```
Script path: /usr/bin/npm
Heap Size: 9.98 MiB
Heap Usage: 76.48%
```

### **DEPOIS (CORRETO - Node direto):**
```
Script path: index.js
Heap Size: ~4096 MiB
Heap Usage: <1%
```

## ⚠️ Importante

**NUNCA use:**
```bash
pm2 start "npm run start:bot1"  # ERRADO!
```

**SEMPRE use:**
```bash
pm2 start index.js --name bot1 --node-args="..."  # CORRETO!
# OU
pm2 start ecosystem.config.js  # CORRETO!
```

## 🔍 Verificação Final

Depois de corrigir, execute:

```bash
pm2 list
pm2 describe bot1
```

**Deve mostrar:**
- ✅ `interpreter: node`
- ✅ `script: index.js` (não `/usr/bin/npm`)
- ✅ `node_args: --max-old-space-size=4096`
- ✅ Heap Size: ~4096 MiB (não ~10 MiB)

## 🚀 Comandos Completos (Copiar e Colar)

```bash
# 1. Parar e remover
pm2 stop bot1
pm2 delete bot1

# 2. Limpar logs
pm2 flush bot1

# 3. Iniciar corretamente
pm2 start index.js --name bot1 \
  --node-args="--max-old-space-size=4096 --max-snapshots=1" \
  --env WHATSAPP_PROVIDER=baileys \
  --env PORT=3009 \
  --env BAILEYS_SESSION_ID=bot1 \
  --env BAILEYS_LOG_LEVEL=silent

# 4. Verificar
pm2 describe bot1 | grep -E "interpreter|script|node_args"

# 5. Salvar
pm2 save
```

## ✅ Resultado Esperado

Depois de corrigir:
- Heap Size: ~4096 MiB (não mais 9.98 MiB)
- Heap Usage: <1% (não mais 76%)
- Script path: `index.js` (não mais `/usr/bin/npm`)
- Interpreter: `node` (não mais `npm`)


