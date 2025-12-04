# 🔧 Resolver Erro "cross-env: not found" na VPS

## ⚠️ Problema:
O `cross-env` não está instalado na VPS.

## ✅ Solução 1: Instalar cross-env (RECOMENDADO)

```bash
# Na VPS:
cd /meubootPilar/botZcnet

# Instale todas as dependências (incluindo devDependencies)
npm install

# OU instale apenas cross-env
npm install cross-env --save-dev

# Agora pode rodar:
npm run start:bot2
```

## ✅ Solução 2: Rodar sem cross-env (alternativa)

Se não quiser instalar cross-env, pode rodar diretamente:

```bash
# Bot1:
WHATSAPP_PROVIDER=baileys PORT=3009 BAILEYS_SESSION_ID=bot1 node index.js

# Bot2:
WHATSAPP_PROVIDER=baileys PORT=3010 BAILEYS_SESSION_ID=bot2 node index.js

# Bot3:
WHATSAPP_PROVIDER=baileys PORT=3011 BAILEYS_SESSION_ID=bot3 node index.js
```

## ✅ Solução 3: Usar PM2 com variáveis de ambiente

```bash
# Bot1:
pm2 start index.js --name "bot1" --interpreter node --env WHATSAPP_PROVIDER=baileys,PORT=3009,BAILEYS_SESSION_ID=bot1

# Bot2:
pm2 start index.js --name "bot2" --interpreter node --env WHATSAPP_PROVIDER=baileys,PORT=3010,BAILEYS_SESSION_ID=bot2
```

## 🎯 Recomendação:

**Instale o cross-env** (Solução 1) para manter consistência com o código local.





