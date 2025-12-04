# 🔧 Comandos para Resolver Bad MAC Error na VPS

## ⚠️ SITUAÇÃO ATUAL:
- Bot está gerando QR code (tentando reconectar)
- Erro Bad MAC continua aparecendo
- Isso indica sessão corrompida ou múltiplas instâncias

## ✅ EXECUTE ESTES COMANDOS NA VPS (na ordem):

### 1. **PARAR TODAS AS INSTÂNCIAS**

```bash
# Pare todos os processos PM2
pm2 stop all
pm2 delete all

# Verifique se parou
pm2 list
```

### 2. **VERIFICAR PROCESSOS NODE RESTANTES**

```bash
# Veja todos os processos Node rodando
ps aux | grep node

# Se houver processos, mate todos:
pkill -f "node.*index.js"
pkill -f "node.*botZcnet"

# Aguarde 3 segundos
sleep 3

# Verifique novamente (deve estar vazio)
ps aux | grep node | grep -v grep
```

### 3. **VERIFICAR MÚLTIPLAS INSTÂNCIAS**

```bash
# Verifique quantas instâncias estão usando a porta 3009
netstat -tulpn | grep 3009

# Verifique diretórios de tokens
ls -la /novobot1/botZcnet/tokens-*

# Verifique se há múltiplos diretórios para o mesmo bot
find /novobot1/botZcnet -name "tokens-*" -type d
```

### 4. **LIMPAR COMPLETAMENTE OS TOKENS**

```bash
# Vá para o diretório do bot
cd /novobot1/botZcnet

# Faça backup (caso precise depois)
cp -r tokens-bot1 tokens-bot1-backup-$(date +%Y%m%d-%H%M%S) 2>/dev/null || echo "Backup não necessário"

# LIMPE COMPLETAMENTE os tokens do bot1
rm -rf tokens-bot1/*

# OU se quiser limpar completamente e recriar:
rm -rf tokens-bot1
mkdir -p tokens-bot1

# Verifique se foi limpo
ls -la tokens-bot1/
```

### 5. **VERIFICAR CONFIGURAÇÃO DO PM2**

```bash
# Verifique se há configurações antigas do PM2
pm2 show bot1 2>/dev/null || echo "Bot1 não existe no PM2 (ok)"

# Limpe o PM2 completamente
pm2 kill
pm2 resurrect 2>/dev/null || echo "Nenhuma configuração salva"
```

### 6. **REINICIAR COM CONFIGURAÇÃO CORRETA**

```bash
# Certifique-se de estar no diretório correto
cd /novobot1/botZcnet

# Verifique se o código está atualizado (com tratamento de Bad MAC)
# Se não estiver, atualize o código primeiro!

# Verifique se cross-env está instalado
npm list cross-env || npm install cross-env --save-dev

# Inicie o bot1 usando o script npm (RECOMENDADO)
pm2 start npm --name "bot1" -- run start:bot1

# OU se preferir, pode usar diretamente:
# pm2 start index.js --name "bot1" --update-env --env WHATSAPP_PROVIDER=baileys,PORT=3009,BAILEYS_SESSION_ID=bot1

# Salve a configuração
pm2 save
```

### 7. **MONITORAR OS LOGS**

```bash
# Veja os logs em tempo real
pm2 logs bot1 --lines 100

# OU veja apenas erros
pm2 logs bot1 --err --lines 50
```

## 🔍 VERIFICAÇÕES IMPORTANTES:

### Verificar se há múltiplas instâncias:
```bash
# Liste todos os processos PM2
pm2 list

# Deve mostrar apenas UMA instância do bot1
# Se houver múltiplas, delete todas e reinicie
```

### Verificar se o código está atualizado:
```bash
# Verifique se o arquivo baileysBot.js tem tratamento de Bad MAC
grep -n "Bad MAC" /novobot1/botZcnet/baileysBot.js

# Se não encontrar, o código precisa ser atualizado!
```

### Verificar diretórios de tokens:
```bash
# Deve existir apenas tokens-bot1 (se for bot1)
ls -la /novobot1/botZcnet/tokens-*

# Se houver tokens-baileys1 ou outros, pode estar causando conflito
```

## ⚠️ SE O ERRO PERSISTIR:

1. **Limpe TUDO e reconecte do zero:**
```bash
pm2 stop all
pm2 delete all
pkill -f node
rm -rf /novobot1/botZcnet/tokens-bot1
cd /novobot1/botZcnet
pm2 start npm --name "bot1" -- run start:bot1
```

2. **Escaneie o QR code novamente** (aparecerá nos logs)

3. **Aguarde a conexão completa** antes de testar mensagens

4. **Se ainda persistir**, pode ser problema de versão do Baileys ou código desatualizado

## 📋 CHECKLIST FINAL:

- [ ] Todas as instâncias PM2 paradas
- [ ] Nenhum processo Node rodando
- [ ] Tokens do bot1 completamente limpos
- [ ] Bot1 reiniciado com BAILEYS_SESSION_ID=bot1
- [ ] QR code escaneado e conectado
- [ ] Logs não mostram mais Bad MAC

