#!/bin/bash

# Script para limpar arquivos de documentação desnecessários
# Mantém apenas README.md e PRODUCTION.md

echo "🧹 Limpando arquivos de documentação desnecessários..."

# Lista de arquivos para manter
KEEP_FILES=("README.md" "PRODUCTION.md")

# Conta arquivos .md antes
COUNT_BEFORE=$(find . -maxdepth 1 -name "*.md" -type f | wc -l)

# Remove arquivos .md exceto os que devem ser mantidos
for file in *.md; do
    if [ -f "$file" ]; then
        KEEP=false
        for keep_file in "${KEEP_FILES[@]}"; do
            if [ "$file" == "$keep_file" ]; then
                KEEP=true
                break
            fi
        done
        
        if [ "$KEEP" == false ]; then
            echo "  Removendo: $file"
            rm "$file"
        else
            echo "  Mantendo: $file"
        fi
    fi
done

# Conta arquivos .md depois
COUNT_AFTER=$(find . -maxdepth 1 -name "*.md" -type f | wc -l)

echo ""
echo "✅ Limpeza concluída!"
echo "   Antes: $COUNT_BEFORE arquivos .md"
echo "   Depois: $COUNT_AFTER arquivos .md"
echo "   Removidos: $((COUNT_BEFORE - COUNT_AFTER)) arquivos"


