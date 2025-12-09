#!/bin/bash

# Script para limpar logs do PM2
# Uso: ./pm2-clean-logs.sh [nome-do-bot]
# Se não especificar nome, limpa todos os bots

echo "🧹 Limpando logs do PM2..."

if [ -z "$1" ]; then
    # Limpa todos os bots
    echo "Limpando logs de todos os bots..."
    pm2 flush
    echo "✅ Logs de todos os bots limpos!"
else
    # Limpa bot específico
    echo "Limpando logs do bot: $1"
    pm2 flush $1
    echo "✅ Logs do bot $1 limpos!"
fi

# Também limpa logs antigos do diretório logs/ se existir
if [ -d "./logs" ]; then
    echo "🧹 Limpando logs antigos do diretório logs/..."
    find ./logs -name "*.log" -type f -mtime +7 -delete 2>/dev/null
    echo "✅ Logs antigos (>7 dias) removidos!"
fi

echo ""
echo "📊 Status dos logs:"
pm2 list

