# 🚀 Comandos PM2 para VPS (Linux)

## 📋 Comandos Básicos

### **Iniciar Bots**

```bash
# Iniciar todos os bots
pm2 start ecosystem.config.js

# Iniciar apenas bot1
pm2 start ecosystem.config.js --only bot1

# Iniciar apenas bot2
pm2 start ecosystem.config.js --only bot2

# Iniciar apenas bot3
pm2 start ecosystem.config.js --only bot3
```

### **Parar Bots**

```bash
# Parar todos os bots
pm2 stop ecosystem.config.js

# Parar apenas bot1
pm2 stop bot1

# Parar apenas bot2
pm2 stop bot2

# Parar apenas bot3
pm2 stop bot3
```

### **Reiniciar Bots**

```bash
# Reiniciar todos os bots
pm2 restart ecosystem.config.js

# Reiniciar apenas bot1
pm2 restart bot1

# Reiniciar apenas bot2
pm2 restart bot2

# Reiniciar apenas bot3
pm2 restart bot3
```

### **Ver Status**

```bash
# Ver status de todos os bots
pm2 list

# Ver status detalhado
pm2 status

# Ver informações de um bot específico
pm2 describe bot1
```

### **Ver Logs**

```bash
# Ver logs de todos os bots
pm2 logs

# Ver logs apenas do bot1
pm2 logs bot1

# Ver logs apenas do bot2
pm2 logs bot2

# Ver logs apenas do bot3
pm2 logs bot3

# Ver últimas 100 linhas
pm2 logs --lines 100

# Ver logs em tempo real (seguir)
pm2 logs --follow

# Ver apenas erros
pm2 logs --err

# Ver apenas output
pm2 logs --out
```

### **Monitoramento**

```bash
# Monitorar em tempo real (CPU, memória)
pm2 monit

# Ver informações detalhadas
pm2 show bot1
```

### **Gerenciamento**

```bash
# Salvar configuração atual (para iniciar após reboot)
pm2 save

# Configurar para iniciar automaticamente no boot
pm2 startup

# Deletar todos os processos
pm2 delete all

# Deletar apenas bot1
pm2 delete bot1

# Limpar logs antigos
pm2 flush
```

## 🔄 Fluxo Completo na VPS

### **1. Primeira vez (configuração inicial)**

```bash
# Entrar no diretório
cd /novobot1/botZcnet

# Instalar dependências (se necessário)
npm install

# Iniciar todos os bots
pm2 start ecosystem.config.js

# Salvar configuração
pm2 save

# Configurar para iniciar no boot
pm2 startup
# (Siga as instruções que aparecerem)
```

### **2. Após fazer atualizações (git pull)**

```bash
# Entrar no diretório
cd /novobot1/botZcnet

# Fazer pull
git pull

# Instalar novas dependências (se houver)
npm install

# Reiniciar todos os bots
pm2 restart ecosystem.config.js
```

### **3. Verificar se está funcionando**

```bash
# Ver status
pm2 list

# Ver logs
pm2 logs bot1

# Verificar se porta está aberta
netstat -tulpn | grep 3009
```

## 🐛 Troubleshooting

### **Bot não inicia**

```bash
# Ver logs de erro
pm2 logs bot1 --err

# Ver informações detalhadas
pm2 describe bot1

# Tentar iniciar manualmente para ver erro
cd /novobot1/botZcnet
node index.js
```

### **Bot travou/parou**

```bash
# Ver status
pm2 list

# Se estiver "errored" ou "stopped", reiniciar
pm2 restart bot1

# Ver logs para identificar problema
pm2 logs bot1 --lines 50
```

### **Bot consumindo muita memória**

```bash
# Ver uso de memória
pm2 monit

# Se passar de 2GB, PM2 reinicia automaticamente (configurado)
# Mas você pode reiniciar manualmente:
pm2 restart bot1
```

### **Limpar tudo e começar do zero**

```bash
# Parar tudo
pm2 stop all

# Deletar tudo
pm2 delete all

# Limpar logs
pm2 flush

# Iniciar novamente
pm2 start ecosystem.config.js
```

## 📊 Comandos Úteis

```bash
# Ver uso de recursos
pm2 monit

# Ver informações de um bot
pm2 show bot1

# Reiniciar com zero downtime (reload)
pm2 reload bot1

# Ver histórico de restarts
pm2 info bot1

# Exportar configuração
pm2 ecosystem

# Ver processos em formato JSON
pm2 jlist
```

## 🔐 Configurar Auto-start no Boot

```bash
# Gerar script de startup
pm2 startup

# (Vai mostrar um comando, execute ele como root)
# Exemplo: sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u seu_usuario --hp /home/seu_usuario

# Salvar configuração atual
pm2 save
```

## 💡 Dicas

1. **Sempre use `pm2 save`** após iniciar bots para salvar configuração
2. **Use `pm2 logs`** para debugar problemas
3. **Use `pm2 monit`** para monitorar recursos em tempo real
4. **Configure `pm2 startup`** para iniciar automaticamente após reboot do servidor
5. **Logs ficam em** `./logs/` (bot1-error.log, bot1-out.log, etc.)

## 📝 Exemplo de Sessão Completa

```bash
# 1. Entrar no diretório
cd /novobot1/botZcnet

# 2. Atualizar código
git pull

# 3. Instalar dependências
npm install

# 4. Reiniciar bot1
pm2 restart bot1

# 5. Ver logs
pm2 logs bot1 --lines 20

# 6. Verificar status
pm2 list
```

