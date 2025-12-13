# 📚 Guia: PM2 vs npm run start

## 🔄 Diferença entre as duas formas

### ❌ **ANTES (usando npm run start)**
```bash
# Terminal 1
npm run start:bot1

# Terminal 2  
npm run start:bot2
```

**Problemas:**
- Rodava via npm → heap reduzido
- Precisava de 2 terminais abertos
- Se terminal fechar, bot para
- Sem auto-restart em caso de crash
- Logs enormes enchendo heap

### ✅ **AGORA (usando PM2 com ecosystem.config.js)**
```bash
# Um único comando inicia TODOS os bots
pm2 start ecosystem.config.js

# Ou iniciar bot específico
pm2 start ecosystem.config.js --only bot1
pm2 start ecosystem.config.js --only bot2
```

**Vantagens:**
- Node direto → heap de 4GB
- Um único comando gerencia todos
- Funciona em background (não precisa terminal aberto)
- Auto-restart automático em caso de crash
- Logs limitados e comprimidos
- Logs do Baileys desativados

## 🚀 Como Usar Agora

### **Iniciar todos os bots de uma vez:**
```bash
pm2 start ecosystem.config.js
```

Isso vai iniciar:
- `bot1` na porta 3009
- `bot2` na porta 3010  
- `bot3` na porta 3011

### **Iniciar apenas bot1:**
```bash
pm2 start ecosystem.config.js --only bot1
```

### **Iniciar apenas bot2:**
```bash
pm2 start ecosystem.config.js --only bot2
```

### **Iniciar bot1 e bot2 (sem bot3):**
```bash
pm2 start ecosystem.config.js --only bot1,bot2
```

## 📊 Gerenciamento Individual

Mesmo iniciando todos juntos, você pode gerenciar cada bot individualmente:

```bash
# Ver status de todos
pm2 list

# Reiniciar apenas bot1
pm2 restart bot1

# Parar apenas bot2
pm2 stop bot2

# Ver logs apenas do bot1
pm2 logs bot1

# Ver logs apenas do bot2
pm2 logs bot2

# Ver logs de ambos
pm2 logs bot1 bot2
```

## 🔄 Migração dos Scripts npm

Se você ainda quiser manter os scripts npm para desenvolvimento local, pode atualizar o `package.json`:

```json
{
  "scripts": {
    "start": "node index.js",
    "start:baileys": "cross-env WHATSAPP_PROVIDER=baileys node index.js",
    "start:bot1": "cross-env WHATSAPP_PROVIDER=baileys PORT=3009 BAILEYS_SESSION_ID=bot1 node index.js",
    "start:bot2": "cross-env WHATSAPP_PROVIDER=baileys PORT=3010 BAILEYS_SESSION_ID=bot2 node index.js",
    "start:bot3": "cross-env WHATSAPP_PROVIDER=baileys PORT=3011 BAILEYS_SESSION_ID=bot3 node index.js",
    
    // NOVOS: Scripts para usar PM2 em produção
    "pm2:start": "pm2 start ecosystem.config.js",
    "pm2:start:bot1": "pm2 start ecosystem.config.js --only bot1",
    "pm2:start:bot2": "pm2 start ecosystem.config.js --only bot2",
    "pm2:start:bot3": "pm2 start ecosystem.config.js --only bot3",
    "pm2:stop": "pm2 stop ecosystem.config.js",
    "pm2:restart": "pm2 restart ecosystem.config.js",
    "pm2:logs": "pm2 logs",
    "pm2:list": "pm2 list"
  }
}
```

## 📋 Comparação Rápida

| Ação | npm run start | PM2 ecosystem.config.js |
|------|---------------|-------------------------|
| **Iniciar bot1** | `npm run start:bot1` | `pm2 start ecosystem.config.js --only bot1` |
| **Iniciar bot2** | `npm run start:bot2` | `pm2 start ecosystem.config.js --only bot2` |
| **Iniciar todos** | 2 comandos separados | `pm2 start ecosystem.config.js` |
| **Reiniciar bot1** | Ctrl+C + `npm run start:bot1` | `pm2 restart bot1` |
| **Ver logs bot1** | Terminal onde rodou | `pm2 logs bot1` |
| **Auto-restart** | ❌ Não | ✅ Sim |
| **Background** | ❌ Precisa terminal | ✅ Não precisa |
| **Heap** | ❌ Reduzido | ✅ 4GB |
| **Logs Baileys** | ❌ Ativados | ✅ Desativados |

## 🎯 Recomendação

### **Em Produção (Servidor):**
✅ **USE PM2 com ecosystem.config.js**
```bash
pm2 start ecosystem.config.js
pm2 save
```

### **Em Desenvolvimento Local:**
✅ **USE npm run start** (para testar rapidamente)
```bash
npm run start:bot1  # Em um terminal
npm run start:bot2  # Em outro terminal
```

## 🔧 Se Você Está Acostumado com npm run start

Se você prefere continuar usando comandos similares, pode criar aliases ou scripts npm:

```bash
# Criar alias no .bashrc ou .zshrc
alias bot1='pm2 start ecosystem.config.js --only bot1'
alias bot2='pm2 start ecosystem.config.js --only bot2'
alias botstop='pm2 stop all'
alias botrestart='pm2 restart all'
alias botlogs='pm2 logs'
```

Depois:
```bash
bot1      # Inicia bot1
bot2      # Inicia bot2
botlogs   # Ver logs
```

## ⚠️ Importante

**NÃO misture as duas formas!**

❌ **ERRADO:**
```bash
pm2 start ecosystem.config.js  # Inicia bot1 e bot2
npm run start:bot1              # Tenta iniciar bot1 novamente (CONFLITO!)
```

✅ **CORRETO:**
```bash
# Opção 1: Usar apenas PM2
pm2 start ecosystem.config.js

# Opção 2: Usar apenas npm (desenvolvimento)
npm run start:bot1
npm run start:bot2
```

## 🚀 Passo a Passo para Migrar

1. **Parar bots antigos (se estiverem rodando via npm):**
   ```bash
   # Se estiverem rodando em terminais, pressione Ctrl+C em cada um
   # Ou mate os processos:
   pkill -f "node.*index.js"
   ```

2. **Parar bots no PM2 (se houver):**
   ```bash
   pm2 stop all
   pm2 delete all
   ```

3. **Limpar logs:**
   ```bash
   pm2 flush
   ```

4. **Iniciar com PM2:**
   ```bash
   pm2 start ecosystem.config.js
   ```

5. **Verificar:**
   ```bash
   pm2 list
   pm2 logs bot1 --lines 20
   pm2 logs bot2 --lines 20
   ```

6. **Salvar configuração:**
   ```bash
   pm2 save
   ```

Pronto! Agora seus bots estão rodando via PM2 com todas as melhorias! 🎉



