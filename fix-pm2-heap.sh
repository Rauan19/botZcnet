#!/bin/bash

# Script para corrigir problema de heap no PM2
# Detecta automaticamente o arquivo principal e ajusta os comandos

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔧 Script de Correção de Heap PM2${NC}"
echo ""

# Detecta arquivo principal
if [ -f "package.json" ]; then
    MAIN_FILE=$(node -e "console.log(require('./package.json').main || 'index.js')")
else
    MAIN_FILE="index.js"
fi

# Verifica se arquivo existe
if [ ! -f "$MAIN_FILE" ]; then
    echo -e "${RED}❌ Arquivo $MAIN_FILE não encontrado!${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Arquivo principal detectado: $MAIN_FILE${NC}"
echo ""

# Nome do bot (padrão bot1, pode ser passado como argumento)
BOT_NAME=${1:-bot1}
HEAP_SIZE=${2:-4096}

echo -e "${YELLOW}📋 Configuração:${NC}"
echo "  Bot: $BOT_NAME"
echo "  Arquivo: $MAIN_FILE"
echo "  Heap: ${HEAP_SIZE} MiB"
echo ""

# Variáveis de ambiente baseadas no nome do bot
case $BOT_NAME in
    bot1)
        PORT=3009
        SESSION_ID=bot1
        ;;
    bot2)
        PORT=3010
        SESSION_ID=bot2
        ;;
    bot3)
        PORT=3011
        SESSION_ID=bot3
        ;;
    *)
        PORT=3009
        SESSION_ID=$BOT_NAME
        ;;
esac

echo -e "${YELLOW}🔍 Verificando processos atuais...${NC}"
pm2 list | grep -E "bot1|bot2|bot3" || echo "Nenhum bot encontrado"
echo ""

# Pergunta se quer continuar
read -p "Deseja continuar? (s/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[SsYy]$ ]]; then
    echo -e "${YELLOW}Operação cancelada.${NC}"
    exit 0
fi

echo ""
echo -e "${YELLOW}1. Parando bot $BOT_NAME...${NC}"
pm2 stop $BOT_NAME 2>/dev/null || echo "Bot não estava rodando"
echo -e "${GREEN}✅ Bot parado${NC}"
echo ""

echo -e "${YELLOW}2. Removendo bot $BOT_NAME do PM2...${NC}"
pm2 delete $BOT_NAME 2>/dev/null || echo "Bot não existia no PM2"
echo -e "${GREEN}✅ Bot removido${NC}"
echo ""

echo -e "${YELLOW}3. Limpando logs...${NC}"
pm2 flush $BOT_NAME 2>/dev/null || echo "Nenhum log para limpar"
echo -e "${GREEN}✅ Logs limpos${NC}"
echo ""

echo -e "${YELLOW}4. Iniciando bot $BOT_NAME com Node direto...${NC}"
echo -e "${BLUE}Comando executado:${NC}"
echo "pm2 start $MAIN_FILE --name $BOT_NAME \\"
echo "  --node-args=\"--max-old-space-size=$HEAP_SIZE --max-snapshots=1\" \\"
echo "  --env WHATSAPP_PROVIDER=baileys \\"
echo "  --env PORT=$PORT \\"
echo "  --env BAILEYS_SESSION_ID=$SESSION_ID \\"
echo "  --env BAILEYS_LOG_LEVEL=silent"
echo ""

pm2 start $MAIN_FILE \
  --name $BOT_NAME \
  --node-args="--max-old-space-size=$HEAP_SIZE --max-snapshots=1" \
  --env WHATSAPP_PROVIDER=baileys \
  --env PORT=$PORT \
  --env BAILEYS_SESSION_ID=$SESSION_ID \
  --env BAILEYS_LOG_LEVEL=silent

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Bot iniciado com sucesso!${NC}"
else
    echo -e "${RED}❌ Erro ao iniciar bot${NC}"
    exit 1
fi

echo ""
echo -e "${YELLOW}5. Verificando configuração...${NC}"
echo ""
pm2 describe $BOT_NAME | grep -E "interpreter|node_args|script|name" || echo "Erro ao obter informações"

echo ""
echo -e "${YELLOW}6. Status do bot:${NC}"
pm2 list | grep $BOT_NAME

echo ""
echo -e "${GREEN}✅ Correção concluída!${NC}"
echo ""
echo -e "${BLUE}📊 Comandos úteis:${NC}"
echo "  pm2 logs $BOT_NAME          - Ver logs"
echo "  pm2 describe $BOT_NAME      - Ver detalhes"
echo "  pm2 monit                   - Monitorar recursos"
echo "  pm2 restart $BOT_NAME      - Reiniciar"
echo "  pm2 stop $BOT_NAME         - Parar"
echo ""



