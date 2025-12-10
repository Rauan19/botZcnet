# 🔧 Solução para Heap Overflow - Logs do Baileys

## 📋 Problema Identificado

O bot Baileys estava caindo porque:
- ✅ **Logs enormes de criptografia** sendo escritos no console
- ✅ **Heap do Node estourando** devido ao limite reduzido ao rodar via npm
- ✅ **Logs do PM2 acumulando** e consumindo memória

## ✅ Solução Implementada

### 1. **Rodar Node Diretamente (não via npm)**
- ✅ PM2 agora executa `node index.js` diretamente
- ✅ Evita overhead do npm que reduz limite de heap
- ✅ Configurado em `ecosystem.config.js`

### 2. **Heap Aumentado**
- ✅ `--max-old-space-size=4096` (4GB de heap)
- ✅ `--max-snapshots=1` (reduz uso de memória)
- ✅ Configurado no `node_args` do PM2

### 3. **Logs do Baileys Completamente Desativados**
- ✅ `BAILEYS_LOG_LEVEL=silent` força logger completamente silencioso
- ✅ Logger customizado que não escreve nada quando em modo silent
- ✅ Implementado em `baileysBot.js` linha 27-52

### 4. **Limpeza Automática de Logs**
- ✅ Logs limitados a 10MB por arquivo
- ✅ Mantém apenas 3 arquivos de log
- ✅ Comprime logs antigos automaticamente
- ✅ Script `pm2-clean-logs.sh` para limpeza manual

## 🚀 Como Aplicar no Servidor

### Passo 1: Fazer deploy dos arquivos atualizados
```bash
# No servidor, fazer pull das mudanças
cd /novobot1/botZcnet
git pull  # ou fazer upload dos arquivos:
# - ecosystem.config.js
# - baileysBot.js (atualizado)
# - pm2-clean-logs.sh
# - migrate-pm2.sh
```

### Passo 2: Parar bots atuais
```bash
pm2 stop all
pm2 delete all
```

### Passo 3: Limpar logs antigos
```bash
# Tornar scripts executáveis
chmod +x pm2-clean-logs.sh migrate-pm2.sh

# Limpar logs
./pm2-clean-logs.sh

# Ou usar script de migração completo
./migrate-pm2.sh
```

### Passo 4: Iniciar com nova configuração
```bash
# Iniciar todos os bots
pm2 start ecosystem.config.js

# Verificar status
pm2 list

# Ver logs
pm2 logs bot1 --lines 50
```

### Passo 5: Salvar configuração
```bash
pm2 save
pm2 startup  # Segue instruções para iniciar no boot
```

## 📊 Verificação

### Verificar se está usando Node direto:
```bash
pm2 describe bot1 | grep "interpreter"
# Deve mostrar: interpreter: node
```

### Verificar heap aumentado:
```bash
pm2 describe bot1 | grep "node_args"
# Deve mostrar: --max-old-space-size=4096
```

### Verificar logs desativados:
```bash
pm2 env bot1 | grep BAILEYS_LOG_LEVEL
# Deve mostrar: BAILEYS_LOG_LEVEL=silent
```

### Monitorar uso de memória:
```bash
pm2 monit
# Verificar se não está passando de 2GB por bot
```

## 🔍 Arquivos Modificados

1. **ecosystem.config.js** (NOVO)
   - Configuração PM2 com Node direto
   - Heap aumentado para 4GB
   - Logs limitados e comprimidos
   - BAILEYS_LOG_LEVEL=silent

2. **baileysBot.js** (ATUALIZADO)
   - Logger completamente silencioso quando BAILEYS_LOG_LEVEL=silent
   - Logger customizado que não escreve nada
   - Filtro melhorado de mensagens normais do libsignal

3. **pm2-clean-logs.sh** (NOVO)
   - Script para limpar logs do PM2
   - Remove logs antigos do diretório logs/

4. **migrate-pm2.sh** (NOVO)
   - Script completo de migração
   - Para bots antigos, limpa logs, inicia novos

## ⚠️ Importante

1. **NUNCA rode múltiplas instâncias com o mesmo `BAILEYS_SESSION_ID`**
2. **SEMPRE use `BAILEYS_SESSION_ID` diferente para cada bot**
3. **Monitore uso de memória**: `pm2 monit`
4. **Limpe logs regularmente**: `./pm2-clean-logs.sh` ou `pm2 flush`
5. **Verifique se logs do Baileys estão realmente desativados**: `pm2 logs bot1` não deve mostrar logs de criptografia

## 📈 Resultados Esperados

### Antes:
- ❌ Bot caindo por heap overflow
- ❌ Logs enormes de criptografia
- ❌ Memória esgotando rapidamente
- ❌ PM2 rodando via npm (heap reduzido)

### Depois:
- ✅ Bot estável com heap de 4GB
- ✅ Logs do Baileys completamente desativados
- ✅ Uso de memória controlado
- ✅ PM2 rodando Node diretamente
- ✅ Logs limitados e comprimidos automaticamente

## 🔧 Troubleshooting

### Bot ainda está caindo?
```bash
# Verificar uso de memória
pm2 monit

# Ver logs de erro
pm2 logs bot1 --err --lines 100

# Verificar se heap está sendo respeitado
pm2 describe bot1 | grep node_args
```

### Logs ainda aparecendo?
```bash
# Verificar variável de ambiente
pm2 env bot1 | grep BAILEYS_LOG_LEVEL

# Se não estiver como 'silent', reiniciar
pm2 restart bot1
```

### Heap ainda estourando?
```bash
# Aumentar heap no ecosystem.config.js
# Mudar de 4096 para 8192 (8GB)
node_args: '--max-old-space-size=8192'

# Reiniciar
pm2 restart ecosystem.config.js
```

## 📝 Comandos Rápidos

```bash
# Status
pm2 list

# Logs
pm2 logs bot1

# Reiniciar
pm2 restart bot1

# Limpar logs
pm2 flush bot1

# Monitorar
pm2 monit

# Verificar configuração
pm2 describe bot1
```


