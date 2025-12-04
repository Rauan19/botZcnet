# 🚀 Comandos PM2 Corretos para os Bots

## ✅ FORMA CORRETA (usando npm run):

### Bot1:
```bash
cd /novobot1/botZcnet
pm2 start npm --name "bot1" -- run start:bot1
pm2 save
```

### Bot2:
```bash
cd /novobot1/botZcnet
pm2 start npm --name "bot2" -- run start:bot2
pm2 save
```

### Bot3:
```bash
cd /novobot1/botZcnet
pm2 start npm --name "bot3" -- run start:bot3
pm2 save
```

## 📋 Comandos Úteis do PM2:

```bash
# Ver status de todos os bots
pm2 list

# Ver logs do bot1
pm2 logs bot1

# Ver logs de todos os bots
pm2 logs

# Parar bot1
pm2 stop bot1

# Reiniciar bot1
pm2 restart bot1

# Deletar bot1
pm2 delete bot1

# Parar todos
pm2 stop all

# Reiniciar todos
pm2 restart all

# Ver informações detalhadas do bot1
pm2 show bot1

# Monitorar em tempo real
pm2 monit
```

## ⚠️ IMPORTANTE:

1. **Sempre use `npm run start:botX`** - isso garante que as variáveis de ambiente corretas sejam usadas
2. **Certifique-se de que `cross-env` está instalado** na VPS:
   ```bash
   npm install cross-env --save-dev
   ```
3. **Cada bot deve ter um nome único no PM2** (`bot1`, `bot2`, `bot3`)
4. **Sempre salve a configuração** após iniciar: `pm2 save`

## 🔧 Resolver Bad MAC Error (comandos completos):

```bash
# 1. Pare tudo
pm2 stop all
pm2 delete all
pkill -f node

# 2. Limpe tokens
cd /novobot1/botZcnet
rm -rf tokens-bot1/*

# 3. Verifique se cross-env está instalado
npm install cross-env --save-dev

# 4. Reinicie usando npm run
pm2 start npm --name "bot1" -- run start:bot1
pm2 save

# 5. Monitore logs
pm2 logs bot1
```



