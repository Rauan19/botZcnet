# 🚀 Configuração PM2 - Solução para Heap Overflow

## 📋 Problema Identificado

O bot Baileys estava caindo porque:
- Logs enormes de criptografia sendo escritos no console
- Heap do Node estourando devido ao limite reduzido ao rodar via npm
- Logs do PM2 acumulando e consumindo memória

## ✅ Solução Implementada

### 1. **Rodar Node Diretamente (não via npm)**
- PM2 agora executa `node index.js` diretamente
- Evita overhead do npm que reduz limite de heap

### 2. **Heap Aumentado**
- `--max-old-space-size=4096` (4GB de heap)
- `--max-snapshots=1` (reduz uso de memória)

### 3. **Logs do Baileys Completamente Desativados**
- `BAILEYS_LOG_LEVEL=silent` força logger completamente silencioso
- Logger customizado que não escreve nada quando em modo silent

### 4. **Limpeza Automática de Logs**
- Logs limitados a 10MB por arquivo
- Mantém apenas 3 arquivos de log
- Comprime logs antigos automaticamente

## 🚀 Como Usar

### 1. **Parar bots atuais (se estiverem rodando via npm)**
```bash
pm2 stop all
pm2 delete all
```

### 2. **Limpar logs antigos**
```bash
# Tornar script executável
chmod +x pm2-clean-logs.sh

# Limpar todos os logs
./pm2-clean-logs.sh

# Ou limpar bot específico
./pm2-clean-logs.sh bot1
```

### 3. **Iniciar bots com nova configuração**
```bash
# Iniciar todos os bots usando ecosystem.config.js
pm2 start ecosystem.config.js

# Ou iniciar bot específico
pm2 start ecosystem.config.js --only bot1
```

### 4. **Salvar configuração do PM2**
```bash
pm2 save
pm2 startup  # Segue instruções para iniciar no boot
```

## 📊 Comandos Úteis

### Monitoramento
```bash
# Ver status de todos os bots
pm2 list

# Ver logs em tempo real
pm2 logs

# Ver logs de bot específico
pm2 logs bot1

# Ver apenas últimas 50 linhas
pm2 logs bot1 --lines 50

# Monitorar uso de memória/CPU
pm2 monit
```

### Gerenciamento
```bash
# Reiniciar bot
pm2 restart bot1

# Parar bot
pm2 stop bot1

# Iniciar bot
pm2 start bot1

# Recarregar (zero downtime)
pm2 reload bot1

# Deletar bot
pm2 delete bot1
```

### Limpeza de Logs
```bash
# Limpar todos os logs
pm2 flush

# Limpar logs de bot específico
pm2 flush bot1

# Usar script de limpeza
./pm2-clean-logs.sh
```

## 🔧 Configurações Aplicadas

### Heap e Memória
- `--max-old-space-size=4096`: 4GB de heap
- `--max-snapshots=1`: Reduz uso de memória

### Logs
- `max_size: '10M'`: Limite de 10MB por arquivo
- `retain: 3`: Mantém apenas 3 arquivos
- `compress: true`: Comprime logs antigos
- `BAILEYS_LOG_LEVEL=silent`: Desativa logs do Baileys

### Auto-restart
- `autorestart: true`: Reinicia automaticamente em caso de crash
- `max_restarts: 10`: Máximo de 10 restarts em 10 segundos
- `min_uptime: '10s'`: Considera estável após 10 segundos

## 📁 Estrutura de Logs

```
logs/
├── bot1-error.log      # Erros do bot1
├── bot1-out.log        # Output do bot1
├── bot1-combined.log   # Logs combinados do bot1
├── bot2-error.log      # Erros do bot2
├── bot2-out.log        # Output do bot2
├── bot2-combined.log   # Logs combinados do bot2
├── bot3-error.log      # Erros do bot3
├── bot3-out.log        # Output do bot3
└── bot3-combined.log   # Logs combinados do bot3
```

## ⚠️ Importante

1. **NUNCA rode múltiplas instâncias com o mesmo `BAILEYS_SESSION_ID`**
2. **SEMPRE use `BAILEYS_SESSION_ID` diferente para cada bot**
3. **Monitore uso de memória**: `pm2 monit`
4. **Limpe logs regularmente**: `./pm2-clean-logs.sh`

## 🔍 Troubleshooting

### Bot ainda está caindo?
```bash
# Verificar uso de memória
pm2 monit

# Ver logs de erro
pm2 logs bot1 --err

# Verificar se heap está sendo respeitado
pm2 describe bot1 | grep node_args
```

### Logs ainda muito grandes?
```bash
# Limpar manualmente
pm2 flush bot1

# Verificar tamanho dos logs
du -sh ~/.pm2/logs/*
```

### Heap ainda estourando?
```bash
# Aumentar heap no ecosystem.config.js
node_args: '--max-old-space-size=8192'  # 8GB

# Reiniciar
pm2 restart ecosystem.config.js
```

## 📈 Monitoramento Recomendado

1. **Uso de memória**: Não deve passar de 2GB por bot
2. **Tamanho dos logs**: Não deve passar de 10MB por arquivo
3. **Restarts**: Não deve ter mais de 5 restarts por hora
4. **Heap**: Monitorar com `pm2 monit`

