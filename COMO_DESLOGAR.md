# 🔓 Como Deslogar do WhatsApp Bot

## Método 1: Deletar pasta de tokens (RECOMENDADO)

### No Windows (PowerShell):
```powershell
# Para bot1
Remove-Item -Recurse -Force "tokens-bot1"

# Para bot2
Remove-Item -Recurse -Force "tokens-bot2"

# Para bot3
Remove-Item -Recurse -Force "tokens-bot3"
```

### No Linux/Mac:
```bash
# Para bot1
rm -rf tokens-bot1

# Para bot2
rm -rf tokens-bot2

# Para bot3
rm -rf tokens-bot3
```

### No servidor (VPS):
```bash
# Entre na pasta do projeto
cd /novobot1/botZcnet

# Para bot1
rm -rf tokens-bot1

# Para bot2
rm -rf tokens-bot2

# Para bot3
rm -rf tokens-bot3
```

## Método 2: Parar o bot e deletar

```bash
# Pare o bot primeiro
pm2 stop bot1

# Depois delete a pasta
rm -rf tokens-bot1

# Reinicie o bot (vai gerar novo QR)
pm2 start bot1
```

## Método 3: Via código (se tiver endpoint)

Se você quiser adicionar um endpoint para logout, pode usar:

```javascript
// No index.js, adicione:
app.post('/api/session/logout', async (req, res) => {
    try {
        await this.bot.stop();
        await this.bot.cleanupAuthDir();
        res.json({ success: true, message: 'Logout realizado. Reinicie o bot para gerar novo QR.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
```

## ⚠️ IMPORTANTE:

- **Deletar a pasta de tokens** = Deslogar completamente
- Após deletar, quando reiniciar o bot, ele vai gerar um **novo QR code**
- Você precisará **escanear o QR code novamente** com seu WhatsApp
- Os backups em `auth-backups` também podem ser deletados se quiser limpar tudo

## 📁 Localização das pastas:

- **Windows**: `C:\Users\pcdev\Documents\AppZcnet\botZcnet\tokens-bot1`
- **Linux/VPS**: `/novobot1/botZcnet/tokens-bot1`

## ✅ Após deletar:

1. Reinicie o bot: `pm2 restart bot1`
2. O bot vai gerar um novo QR code
3. Escaneie o QR code com seu WhatsApp
4. Pronto! Você está logado com uma nova sessão


