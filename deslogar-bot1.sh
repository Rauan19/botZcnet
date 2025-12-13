#!/bin/bash
# Script para deslogar bot1 completamente

echo "🛑 Parando bot1..."
pm2 stop bot1

echo "⏳ Aguardando 3 segundos..."
sleep 3

echo "🗑️ Deletando tokens do bot1..."
rm -rf tokens-bot1

echo "🗑️ Deletando backups de autenticação..."
rm -rf auth-backups

echo "✅ Tokens deletados!"
echo ""
echo "🔄 Para reiniciar o bot e gerar novo QR code:"
echo "   pm2 start bot1"
echo ""
echo "📱 Após reiniciar, escaneie o novo QR code que aparecerá"


