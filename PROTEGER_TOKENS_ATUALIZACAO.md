# 🛡️ Proteger Tokens Durante Atualizações

## ⚠️ Problema Identificado

Quando você faz `git pull` e reinicia o bot, os tokens podem ser perdidos porque:

1. **Diretório pode ser deletado** durante o pull
2. **Backup pode não estar atualizado** antes do pull
3. **Restore pode não funcionar** corretamente após pull

## ✅ Solução: Script de Atualização Segura

### **1. Criar Script de Backup Antes de Pull**

Crie um arquivo `atualizar-seguro.sh` na VPS:

```bash
#!/bin/bash
# Script para atualizar o bot sem perder tokens

echo "🔄 Iniciando atualização segura..."

# 1. Para o bot
echo "⏸️ Parando bot..."
pm2 stop bot1

# 2. Faz backup dos tokens ANTES do pull
echo "💾 Fazendo backup dos tokens..."
BACKUP_DIR="~/backups-tokens-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp -r tokens-bot1 "$BACKUP_DIR/" 2>/dev/null || echo "⚠️ Diretório tokens-bot1 não encontrado"
cp -r auth-backups "$BACKUP_DIR/" 2>/dev/null || echo "⚠️ Diretório auth-backups não encontrado"

# 3. Faz pull
echo "📥 Fazendo git pull..."
git pull

# 4. Instala dependências
echo "📦 Instalando dependências..."
npm install

# 5. Verifica se tokens ainda existem
if [ ! -d "tokens-bot1" ]; then
    echo "⚠️ Tokens não encontrados! Restaurando do backup..."
    if [ -d "$BACKUP_DIR/tokens-bot1" ]; then
        cp -r "$BACKUP_DIR/tokens-bot1" .
        echo "✅ Tokens restaurados!"
    fi
fi

# 6. Reinicia o bot
echo "🚀 Reiniciando bot..."
pm2 restart bot1

echo "✅ Atualização concluída!"
```

### **2. Tornar Executável:**

```bash
chmod +x atualizar-seguro.sh
```

### **3. Usar o Script:**

```bash
./atualizar-seguro.sh
```

## 🔧 Melhorias no Código

### **Backup Automático Antes de Qualquer Operação Perigosa**

Vou adicionar proteção extra no código para garantir que tokens sejam sempre preservados.


