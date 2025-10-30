# 🚀 Guia de Produção - ZcNet Chat Atendimento

## 📊 Dados Armazenados

### Banco de Dados SQLite
- **Localização**: `data/app.db`
- **Conteúdo**: 
  - Conversas (chats)
  - Mensagens (texto e áudio)
  - Contador de não lidas

### Arquivos de Áudio
- **Localização**: `audios/`
- **Formato**: `.ogg` (Opus)
- **Uso**: Playback de mensagens de áudio enviadas

### Tokens do WhatsApp
- **Localização**: `tokens/zcnet-bot/`
- **Conteúdo**: Sessão do WhatsApp Web
- **Importante**: NÃO apagar, senão precisará reautenticar

### Arquivos Temporários
- **`temp_audio/`**: Áudios temporários durante conversão
- **`temp/boletos/`**: PDFs de boletos gerados

## 🔧 Preparação para VPS

### 1. Estrutura de Diretórios
```
bootZcNe4t/
├── data/                 # 📦 PERSISTENTE
│   └── app.db           # Banco de dados SQLite
├── audios/               # 📦 PERSISTENTE
│   └── *.ogg            # Áudios salvos
├── tokens/               # 📦 PERSISTENTE
│   └── zcnet-bot/       # Sessão WhatsApp
├── temp_audio/           # ⚠️ Pode limpar periodicamente
├── temp/                 # ⚠️ Pode limpar periodicamente
└── node_modules/         # Gitignore
```

### 2. Scripts de Manutenção

#### Limpar arquivos temporários:
```bash
# Linux/Mac
find temp_audio -type f -mtime +7 -delete
find temp/boletos -type f -mtime +7 -delete
```

#### Backup do banco:
```bash
# Copiar database
cp data/app.db data/backup_$(date +%Y%m%d).db
```

### 3. Configuração PM2 (Recomendado)

```bash
# Instalar PM2
npm install -g pm2

# Iniciar aplicação
pm2 start index.js --name zcnet-chat

# Configurar para reiniciar automaticamente
pm2 startup
pm2 save

# Monitorar
pm2 logs zcnet-chat
pm2 status
```

### 4. Configuração Nginx (Opcional)

```nginx
server {
    listen 80;
    server_name seu-dominio.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## 📦 Backup Essenciais

### Antes de fazer deploy:

1. **Banco de dados**:
   ```bash
   cp data/app.db ~/backup_app_$(date +%Y%m%d).db
   ```

2. **Tokens do WhatsApp**:
   ```bash
   tar -czf ~/backup_tokens_$(date +%Y%m%d).tar.gz tokens/
   ```

3. **Áudios**:
   ```bash
   tar -czf ~/backup_audios_$(date +%Y%m%d).tar.gz audios/
   ```

## 🔐 Segurança

1. **Variáveis de ambiente**: Use `.env` para senhas
2. **Firewall**: Libere apenas porta 3000 (ou 80/443 se usar Nginx)
3. **HTTPS**: Use Let's Encrypt para SSL

## 📈 Monitoramento

### Logs importantes:
- `pm2 logs` - Logs da aplicação
- Console output - Status de conexão WhatsApp

### Alertas:
- Bot desconectado do WhatsApp
- Falhas no banco de dados
- Espaço em disco cheio

## 🚨 Troubleshooting

### Bot não conecta:
1. Verificar se tokens/ não foi deletado
2. Verificar logs do PM2
3. Reiniciar: `pm2 restart zcnet-chat`

### Banco corrompido:
1. Parar aplicação: `pm2 stop zcnet-chat`
2. Restaurar backup: `cp backup_app_YYYYMMDD.db data/app.db`
3. Reiniciar: `pm2 start zcnet-chat`

### Sem espaço em disco:
1. Limpar temp_audio: `find temp_audio -type f -delete`
2. Limpar temp/boletos antigos
3. Compactar banco SQLite (se necessário)

## 📊 Migrações Futuras

Se quiser migrar para PostgreSQL:
1. Criar schema similar ao SQLite
2. Modificar `database.js` para usar pg
3. Fazer dump/import dos dados



