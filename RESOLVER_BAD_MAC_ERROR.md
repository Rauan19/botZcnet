# 🔧 Resolver Erro "Bad MAC Error" na VPS

## ⚠️ Problema:
O bot está logado mas não recebe mensagens, com erro:
```
Failed to decrypt message with any known session...
Bad MAC Error: Bad MAC
```

## 🔍 Causas Possíveis:

1. **Múltiplas instâncias usando a mesma sessão** (mais comum)
2. **Sessão corrompida** (arquivos de token danificados)
3. **Conflito entre versões diferentes do código**
4. **Instância antiga ainda rodando** (PM2 não parou completamente)

## ✅ Solução Passo a Passo:

### 1. **PARAR TODAS AS INSTÂNCIAS**

```bash
# Na VPS, pare TODOS os processos:
pm2 stop all
pm2 delete all

# Verifique se ainda há processos Node rodando:
ps aux | grep node

# Se houver, mate manualmente:
pkill -f node
# OU
killall node
```

### 2. **VERIFICAR INSTÂNCIAS DUPLICADAS**

```bash
# Verifique se há múltiplas instâncias do mesmo bot:
pm2 list

# Verifique processos na porta:
netstat -tulpn | grep -E '3009|3010|3011'

# Verifique diretórios de tokens:
ls -la /novobot1/botZcnet/tokens-*
```

### 3. **LIMPAR SESSÃO CORROMPIDA**

```bash
# Pare o bot primeiro:
pm2 stop bot1

# Faça backup dos tokens (caso precise):
cp -r /novobot1/botZcnet/tokens-bot1 /novobot1/botZcnet/tokens-bot1-backup

# Limpe os tokens do bot1:
rm -rf /novobot1/botZcnet/tokens-bot1/*

# OU limpe completamente e reconecte:
rm -rf /novobot1/botZcnet/tokens-bot1
```

### 4. **VERIFICAR CONFIGURAÇÃO DO PM2**

```bash
# Verifique o arquivo de configuração do PM2:
pm2 show bot1

# Verifique se está usando BAILEYS_SESSION_ID correto:
# Deve mostrar: BAILEYS_SESSION_ID=bot1
```

### 5. **REINICIAR COM CONFIGURAÇÃO CORRETA**

```bash
# Certifique-se de que cada bot usa um BAILEYS_SESSION_ID diferente:

# Bot1:
cd /novobot1/botZcnet
pm2 start index.js --name "bot1" --update-env --env WHATSAPP_PROVIDER=baileys,PORT=3009,BAILEYS_SESSION_ID=bot1

# Bot2 (se necessário):
pm2 start index.js --name "bot2" --update-env --env WHATSAPP_PROVIDER=baileys,PORT=3010,BAILEYS_SESSION_ID=bot2

# Salve a configuração:
pm2 save
```

### 6. **VERIFICAR LOGS**

```bash
# Monitore os logs:
pm2 logs bot1 --lines 50

# Verifique se não há mais erros Bad MAC
# Verifique se o bot conecta corretamente
```

## 🎯 Script Automatizado:

Crie um arquivo `limpar_e_reiniciar_bot1.sh`:

```bash
#!/bin/bash

echo "🛑 Parando bot1..."
pm2 stop bot1
pm2 delete bot1

echo "🧹 Limpando tokens corrompidos..."
rm -rf /novobot1/botZcnet/tokens-bot1/*

echo "⏳ Aguardando 5 segundos..."
sleep 5

echo "🚀 Reiniciando bot1..."
cd /novobot1/botZcnet
pm2 start index.js --name "bot1" --update-env --env WHATSAPP_PROVIDER=baileys,PORT=3009,BAILEYS_SESSION_ID=bot1

echo "✅ Bot1 reiniciado!"
echo "📊 Verifique os logs: pm2 logs bot1"
```

Execute:
```bash
chmod +x limpar_e_reiniciar_bot1.sh
./limpar_e_reiniciar_bot1.sh
```

## ⚠️ IMPORTANTE:

1. **NUNCA rode múltiplas instâncias com o mesmo `BAILEYS_SESSION_ID`**
2. **Sempre use `BAILEYS_SESSION_ID` diferente para cada bot**
3. **Verifique se não há instâncias antigas rodando antes de iniciar**
4. **Se o erro persistir, limpe completamente os tokens e reconecte**

## 🔍 Verificação Final:

```bash
# Verifique se cada bot tem seu próprio diretório:
ls -la /novobot1/botZcnet/tokens-*

# Deve mostrar:
# tokens-bot1/  (para bot1)
# tokens-bot2/  (para bot2, se existir)

# Verifique processos PM2:
pm2 list

# Deve mostrar apenas uma instância de cada bot
```





