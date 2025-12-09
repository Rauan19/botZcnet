#!/bin/bash

echo "═══════════════════════════════════════════════════════"
echo "🔧 Script para Resolver Bad MAC Error - Bot1"
echo "═══════════════════════════════════════════════════════"
echo ""

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Verifica se está rodando como root ou com permissões adequadas
if [ "$EUID" -ne 0 ]; then 
    echo -e "${YELLOW}⚠️  Executando sem privilégios de root (pode precisar de sudo)${NC}"
fi

echo "🛑 Parando todas as instâncias do bot1..."
pm2 stop bot1 2>/dev/null || echo "Bot1 não estava rodando"
pm2 delete bot1 2>/dev/null || echo "Bot1 não existia no PM2"

echo ""
echo "🔍 Verificando processos Node restantes..."
NODE_PROCESSES=$(ps aux | grep -E "node.*index.js|node.*botZcnet" | grep -v grep | wc -l)
if [ "$NODE_PROCESSES" -gt 0 ]; then
    echo -e "${YELLOW}⚠️  Encontrados $NODE_PROCESSES processos Node ainda rodando${NC}"
    echo "💡 Matando processos Node restantes..."
    pkill -f "node.*index.js" 2>/dev/null || echo "Nenhum processo encontrado para matar"
    sleep 2
else
    echo -e "${GREEN}✅ Nenhum processo Node encontrado${NC}"
fi

echo ""
echo "📁 Verificando diretórios de tokens..."
if [ -d "/novobot1/botZcnet/tokens-bot1" ]; then
    echo "📂 Diretório tokens-bot1 encontrado"
    echo "💾 Fazendo backup dos tokens..."
    BACKUP_DIR="/novobot1/botZcnet/tokens-bot1-backup-$(date +%Y%m%d-%H%M%S)"
    cp -r /novobot1/botZcnet/tokens-bot1 "$BACKUP_DIR" 2>/dev/null && echo -e "${GREEN}✅ Backup criado em: $BACKUP_DIR${NC}" || echo -e "${YELLOW}⚠️  Não foi possível criar backup${NC}"
    
    echo ""
    echo "🧹 Limpando tokens corrompidos..."
    rm -rf /novobot1/botZcnet/tokens-bot1/*
    echo -e "${GREEN}✅ Tokens limpos${NC}"
else
    echo -e "${YELLOW}⚠️  Diretório tokens-bot1 não encontrado (será criado na próxima inicialização)${NC}"
fi

echo ""
echo "⏳ Aguardando 5 segundos antes de reiniciar..."
sleep 5

echo ""
echo "🚀 Reiniciando bot1..."
cd /novobot1/botZcnet || {
    echo -e "${RED}❌ Erro: Não foi possível acessar /novobot1/botZcnet${NC}"
    exit 1
}

pm2 start index.js --name "bot1" --update-env --env WHATSAPP_PROVIDER=baileys,PORT=3009,BAILEYS_SESSION_ID=bot1

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✅ Bot1 reiniciado com sucesso!${NC}"
    echo ""
    echo "📊 Para verificar os logs, execute:"
    echo "   pm2 logs bot1 --lines 50"
    echo ""
    echo "📋 Para verificar o status:"
    echo "   pm2 status"
    echo ""
    echo "💡 Se o erro Bad MAC persistir:"
    echo "   1. Verifique se não há outras instâncias rodando: pm2 list"
    echo "   2. Verifique se não há processos Node duplicados: ps aux | grep node"
    echo "   3. Limpe completamente os tokens: rm -rf /novobot1/botZcnet/tokens-bot1"
    echo "   4. Reconecte escaneando o QR code novamente"
else
    echo -e "${RED}❌ Erro ao reiniciar bot1${NC}"
    exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "✅ Script concluído!"
echo "═══════════════════════════════════════════════════════"





