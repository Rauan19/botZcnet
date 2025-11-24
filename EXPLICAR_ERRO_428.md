# Erro 428 - Explicacao Completa

## O que e o erro 428?

**428 = "Connection Terminated by Server"**

O WhatsApp **terminou a conexao** do seu bot.

## Por que acontece mesmo com numeros diferentes?

O erro 428 pode acontecer por varios motivos, **nao so conflito de numero**:

### 1. **MULTIPLAS INSTANCIAS DO BAILEYS**
- Se voce tem 2 processos Node rodando o mesmo codigo Baileys
- Mesmo que sejam numeros diferentes, o Baileys pode detectar comportamento suspeito
- O WhatsApp pode bloquear conexoes simultaneas do mesmo IP

### 2. **MESMO DIRETORIO DE TOKENS**
- Se 2 processos usam o mesmo diretorio `tokens-*`
- Mesmo que sejam numeros diferentes, pode causar conflito
- Cada bot DEVE ter seu proprio diretorio

### 3. **RATE LIMITING DO WHATSAPP**
- Muitas tentativas de conexao em pouco tempo
- WhatsApp bloqueia temporariamente o IP
- Pode dar erro 428 mesmo com numeros diferentes

### 4. **PROBLEMA COM VERSAO DO BAILEYS**
- Versao desatualizada pode ter bugs
- WhatsApp pode rejeitar conexoes de versoes antigas

## O que fazer?

### PASSO 1: Verificar processos rodando
```powershell
Get-Process -Name node | Select-Object Id, ProcessName
```

### PASSO 2: Parar TODOS os bots
```powershell
.\PARAR_TODOS_BOTS.ps1
```

### PASSO 3: Verificar diretorios de tokens
```powershell
Get-ChildItem -Path . -Directory -Filter "tokens-*"
```

Cada bot deve ter seu proprio diretorio:
- Bot 1: `tokens-bot1` (ou `tokens-3009`)
- Bot 2: `tokens-bot2` (ou `tokens-3010`)
- Bot 3: `tokens-bot3` (ou `tokens-3011`)

### PASSO 4: Aguardar alguns minutos
- Aguarde 5-10 minutos antes de reiniciar
- Isso evita rate limiting

### PASSO 5: Reiniciar um bot por vez
```powershell
# Bot 1
npm run start:bot1

# Aguarde conectar, depois inicie o proximo
# Bot 2
npm run start:bot2
```

## IMPORTANTE

- **NAO rode 2 bots ao mesmo tempo inicialmente**
- Inicie um, aguarde conectar completamente, depois inicie o proximo
- Cada bot DEVE usar diretorio diferente
- Cada bot DEVE usar porta diferente
- Cada bot DEVE usar numero diferente

## Se persistir

1. Limpe todos os tokens: `Remove-Item -Recurse -Force tokens-*`
2. Aguarde 1 hora
3. Reinicie um bot por vez
4. Se ainda der erro, use whatsapp-web.js temporariamente

