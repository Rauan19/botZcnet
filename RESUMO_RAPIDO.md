# ⚡ Resumo Rápido - PM2 vs npm run start

## 🎯 Para Você que Usa `npm run start:bot1` e `npm run start:bot2`

### ❌ **ANTES (problema):**
```bash
# Terminal 1
npm run start:bot1

# Terminal 2
npm run start:bot2
```
**Problema:** Heap reduzido → logs enormes → bot cai

### ✅ **AGORA (solução):**
```bash
# Um único comando inicia AMBOS os bots
npm run pm2:start

# Ou iniciar individualmente
npm run pm2:start:bot1
npm run pm2:start:bot2
```

## 📋 Comandos Equivalentes

| Você fazia antes | Agora faça |
|------------------|------------|
| `npm run start:bot1` | `npm run pm2:start:bot1` |
| `npm run start:bot2` | `npm run pm2:start:bot2` |
| `npm run start:bot1` + `npm run start:bot2` | `npm run pm2:start` |
| Ctrl+C para parar | `npm run pm2:stop` |
| Ver logs no terminal | `npm run pm2:logs` |

## 🚀 Passo a Passo Rápido

### 1. Parar bots antigos (se estiverem rodando)
```bash
# Se estiverem rodando em terminais, pressione Ctrl+C
# Ou mate os processos:
pkill -f "node.*index.js"
```

### 2. Limpar PM2 (se houver bots antigos)
```bash
npm run pm2:delete
npm run pm2:flush
```

### 3. Iniciar com PM2
```bash
# Iniciar ambos de uma vez
npm run pm2:start

# OU iniciar individualmente
npm run pm2:start:bot1
npm run pm2:start:bot2
```

### 4. Verificar
```bash
npm run pm2:list
npm run pm2:logs:bot1
npm run pm2:logs:bot2
```

### 5. Salvar (para iniciar no boot)
```bash
pm2 save
```

## 🎁 Benefícios Imediatos

✅ **Heap de 4GB** (antes era reduzido)  
✅ **Logs do Baileys desativados** (não enche mais o heap)  
✅ **Auto-restart** (se cair, reinicia sozinho)  
✅ **Background** (não precisa terminal aberto)  
✅ **Logs limitados** (não crescem infinitamente)  

## 🔧 Gerenciamento Diário

```bash
# Ver status
npm run pm2:list

# Ver logs do bot1
npm run pm2:logs:bot1

# Ver logs do bot2
npm run pm2:logs:bot2

# Reiniciar bot1
npm run pm2:restart:bot1

# Reiniciar bot2
npm run pm2:restart:bot2

# Parar tudo
npm run pm2:stop

# Limpar logs
npm run pm2:flush
```

## ⚠️ Importante

**NÃO misture as duas formas!**

❌ **ERRADO:**
```bash
npm run pm2:start        # Inicia via PM2
npm run start:bot1       # Tenta iniciar via npm (CONFLITO!)
```

✅ **CORRETO:**
```bash
# Use APENAS PM2 em produção
npm run pm2:start

# Use APENAS npm run start em desenvolvimento local
npm run start:bot1
```

## 🎯 Resumo em 3 Comandos

```bash
# 1. Iniciar ambos os bots
npm run pm2:start

# 2. Ver logs
npm run pm2:logs

# 3. Ver status
npm run pm2:list
```

Pronto! 🎉

