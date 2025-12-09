# 🔧 Configurar Bot2 Manualmente (sem atualizar código)

## Passo 1: Criar banco de dados separado

```bash
# Na VPS:
cd /novobot1/botZcnet

# Copie o banco do bot1 para bot2
cp data/app-bot1.db data/app-bot2.db

# OU crie um banco novo vazio (se preferir)
# O banco será criado automaticamente quando o bot iniciar
```

## Passo 2: Editar database.js temporariamente

```bash
# Edite o arquivo database.js
nano database.js

# Mude a linha:
# const DB_PATH = path.join(__dirname, 'data', 'app-bot1.db');
# Para:
# const DB_PATH = path.join(__dirname, 'data', 'app-bot2.db');

# Salve (Ctrl+O, Enter, Ctrl+X)
```

## Passo 3: Rodar bot2

```bash
# O bot2 já vai usar tokens-bot2 automaticamente (via BAILEYS_SESSION_ID=bot2)
pm2 start npm --name "bot2" -- run start:bot2
```

## ⚠️ PROBLEMA:

Se você editar `database.js` manualmente, o **bot1 vai parar de funcionar** porque vai tentar usar `app-bot2.db` também!

## ✅ SOLUÇÃO DEFINITIVA:

**Atualize o código na VPS** para ter a versão nova que suporta múltiplos bancos automaticamente!







