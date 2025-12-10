# 🎯 Comandos Corretos para PM2 - Heap Corrigido

## 📋 Comandos para Corrigir Bot1

### **Parar e Remover:**
```bash
pm2 stop bot1
pm2 delete bot1
```

### **Iniciar com Node Direto:**
```bash
pm2 start index.js --name bot1 \
  --node-args="--max-old-space-size=4096 --max-snapshots=1" \
  --env WHATSAPP_PROVIDER=baileys \
  --env PORT=3009 \
  --env BAILEYS_SESSION_ID=bot1 \
  --env BAILEYS_LOG_LEVEL=silent
```

## 📋 Comandos para Corrigir Bot2

### **Parar e Remover:**
```bash
pm2 stop bot2
pm2 delete bot2
```

### **Iniciar com Node Direto:**
```bash
pm2 start index.js --name bot2 \
  --node-args="--max-old-space-size=4096 --max-snapshots=1" \
  --env WHATSAPP_PROVIDER=baileys \
  --env PORT=3010 \
  --env BAILEYS_SESSION_ID=bot2 \
  --env BAILEYS_LOG_LEVEL=silent
```

## 📋 Comandos para Corrigir Bot3

### **Parar e Remover:**
```bash
pm2 stop bot3
pm2 delete bot3
```

### **Iniciar com Node Direto:**
```bash
pm2 start index.js --name bot3 \
  --node-args="--max-old-space-size=4096 --max-snapshots=1" \
  --env WHATSAPP_PROVIDER=baileys \
  --env PORT=3011 \
  --env BAILEYS_SESSION_ID=bot3 \
  --env BAILEYS_LOG_LEVEL=silent
```

## 🚀 Forma Recomendada (Usando ecosystem.config.js)

O arquivo `ecosystem.config.js` já está configurado corretamente! Use:

```bash
# Iniciar todos os bots de uma vez
pm2 start ecosystem.config.js

# Ou iniciar bot específico
pm2 start ecosystem.config.js --only bot1
pm2 start ecosystem.config.js --only bot2
pm2 start ecosystem.config.js --only bot3
```

## 🔍 Verificação

### **Verificar se está usando Node direto:**
```bash
pm2 describe bot1 | grep -E "interpreter|node_args|script"
```

**Deve mostrar:**
```
interpreter: node
node_args: --max-old-space-size=4096 --max-snapshots=1
script: index.js
```

**NÃO deve mostrar:**
```
interpreter: npm
script: npm run start:bot1
```

### **Ver heap real:**
```bash
pm2 describe bot1 | grep -E "heap|memory"
```

Agora deve mostrar heap de ~4096 MiB (ou o valor configurado), não ~8 MiB!

## 🛠️ Script Automático

Use o script `fix-pm2-heap.sh` para correção automática:

```bash
# Tornar executável
chmod +x fix-pm2-heap.sh

# Corrigir bot1
./fix-pm2-heap.sh bot1

# Corrigir bot2
./fix-pm2-heap.sh bot2

# Corrigir bot3
./fix-pm2-heap.sh bot3

# Com heap customizado (ex: 8GB)
./fix-pm2-heap.sh bot1 8192
```

## 📊 Comparação

| Métrica | Via npm (ERRADO) | Via Node Direto (CORRETO) |
|---------|------------------|---------------------------|
| **Heap Size** | ~8.7 MiB | ~4096 MiB |
| **Heap Usage** | 80%+ (falso) | <1% (correto) |
| **Processo Monitorado** | npm | node index.js |
| **node_args Aplicados** | ❌ Não | ✅ Sim |

## ⚠️ Importante

1. **NUNCA use:** `pm2 start "npm run start:bot1"`
2. **SEMPRE use:** `pm2 start ecosystem.config.js` ou `pm2 start index.js`
3. **Verifique sempre** com `pm2 describe` se está usando Node direto


