#!/bin/bash

# Script para migrar bots do PM2 para nova configuração
# Este script:
# 1. Para todos os bots atuais
# 2. Limpa logs antigos
# 3. Inicia bots com nova configuração (Node direto + heap aumentado)

echo "🔄 Migrando bots para nova configuração PM2..."
echo ""

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. Parar todos os bots
echo -e "${YELLOW}1. Parando bots atuais...${NC}"
pm2 stop all 2>/dev/null || echo "Nenhum bot rodando"
pm2 delete all 2>/dev/null || echo "Nenhum bot para deletar"
echo -e "${GREEN}✅ Bots parados${NC}"
echo ""

# 2. Limpar logs antigos
echo -e "${YELLOW}2. Limpando logs antigos...${NC}"
pm2 flush 2>/dev/null || echo "Nenhum log para limpar"
if [ -d "./logs" ]; then
    find ./logs -name "*.log" -type f -mtime +7 -delete 2>/dev/null
    echo -e "${GREEN}✅ Logs antigos removidos${NC}"
else
    mkdir -p ./logs
    echo -e "${GREEN}✅ Diretório de logs criado${NC}"
fi
echo ""

# 3. Verificar se ecosystem.config.js existe
if [ ! -f "ecosystem.config.js" ]; then
    echo -e "${RED}❌ Arquivo ecosystem.config.js não encontrado!${NC}"
    echo "Crie o arquivo ecosystem.config.js antes de continuar."
    exit 1
fi

# 4. Iniciar bots com nova configuração
echo -e "${YELLOW}3. Iniciando bots com nova configuração...${NC}"
pm2 start ecosystem.config.js
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Bots iniciados com sucesso!${NC}"
else
    echo -e "${RED}❌ Erro ao iniciar bots${NC}"
    exit 1
fi
echo ""

# 5. Salvar configuração do PM2
echo -e "${YELLOW}4. Salvando configuração do PM2...${NC}"
pm2 save
echo -e "${GREEN}✅ Configuração salva${NC}"
echo ""

# 6. Mostrar status
echo -e "${YELLOW}5. Status dos bots:${NC}"
pm2 list
echo ""

# 7. Mostrar uso de memória
echo -e "${YELLOW}6. Uso de memória:${NC}"
pm2 list | grep -E "bot[123]|name|memory"
echo ""

# 8. Instruções finais
echo -e "${GREEN}✅ Migração concluída!${NC}"
echo ""
echo "📊 Comandos úteis:"
echo "  pm2 logs          - Ver logs em tempo real"
echo "  pm2 monit          - Monitorar uso de recursos"
echo "  pm2 restart bot1   - Reiniciar bot específico"
echo "  ./pm2-clean-logs.sh - Limpar logs"
echo ""
echo "⚠️  IMPORTANTE:"
echo "  - Verifique se os bots estão rodando: pm2 list"
echo "  - Monitore uso de memória: pm2 monit"
echo "  - Logs do Baileys estão DESATIVADOS (BAILEYS_LOG_LEVEL=silent)"
echo "  - Heap aumentado para 4GB (--max-old-space-size=4096)"
echo ""



