# 🔧 Solução Melhorada para Erros Bad MAC

## 🎯 Problema Identificado

Após 2 dias em produção, os erros Bad MAC continuavam aparecendo mas **não estavam sendo capturados** pelos handlers, então a limpeza automática não era acionada.

### Causa Raiz

Os erros "Session error:Error: Bad MAC" são escritos **diretamente no stderr** pelo libsignal, antes de chegarem aos nossos handlers de eventos do Baileys.

## ✅ Solução Implementada

### 1. **Interceptação do stderr**

- Captura erros Bad MAC escritos diretamente no stderr pelo libsignal
- Detecta padrões "Bad MAC" e "Session error" mesmo quando não passam pelos handlers
- Mantém o fluxo normal do stderr (não bloqueia outros logs)

### 2. **Threshold Reduzido**

- **Antes**: 10 erros em 5 minutos
- **Agora**: 5 erros em 3 minutos
- **Motivo**: Aciona limpeza automática mais rapidamente

### 3. **Proteção Contra Chamadas Prematuras**

- Verifica se os contadores estão inicializados antes de usar
- Evita erros se `handleBadMacError` for chamado antes da inicialização completa

### 4. **Limpeza ao Parar Bot**

- Restaura stderr original quando o bot para
- Evita vazamentos de memória e problemas de estado

## 📊 Como Funciona Agora

```
Erro Bad MAC escrito no stderr pelo libsignal
    ↓
Interceptação do stderr detecta padrão
    ↓
Chama handleBadMacError() assincronamente
    ↓
Incrementa contador
    ↓
Se >= 5 erros em 3 minutos → Limpa sessão e reconecta
```

## 🔄 Mudanças no Código

### Interceptação do stderr

```javascript
// Intercepta stderr para capturar erros Bad MAC do libsignal
this.originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = function(chunk, encoding, fd) {
    const message = chunk ? chunk.toString() : '';
    if (message.includes('Bad MAC') || message.includes('Session error')) {
        // Detecta e trata o erro
        const error = new Error(message.trim().substring(0, 200));
        setImmediate(() => {
            self.handleBadMacError('do libsignal (stderr)', error);
        });
    }
    // Sempre chama o write original
    return self.originalStderrWrite(chunk, encoding, fd);
};
```

### Threshold Reduzido

```javascript
this.badMacErrorThreshold = 5; // Era 10
this.badMacErrorWindow = 3 * 60 * 1000; // Era 5 minutos
```

## 🚀 Como Aplicar

### 1. Fazer deploy do código atualizado

```bash
# No servidor
cd /novobot1/botZcnet
git pull  # ou fazer upload dos arquivos atualizados
```

### 2. Reiniciar o bot

```bash
pm2 restart bot1
```

### 3. Monitorar logs

```bash
pm2 logs bot1 --lines 100 | grep -E "Bad MAC|limpeza|reconectando|Contador"
```

## 📝 Logs Esperados

### Quando detectar erro Bad MAC:

```
❌ ERRO Bad MAC detectado do libsignal (stderr)!
📊 Contador de erros: 1/5
💡 Limpeza automática será acionada após 4 erros adicionais
```

### Quando atingir limite:

```
❌ ERRO Bad MAC detectado do libsignal (stderr)!
📊 Contador de erros: 5/5
⚠️⚠️⚠️ LIMITE DE ERROS BAD MAC ATINGIDO ⚠️⚠️⚠️
   5 erros em 180 segundos
🔄 Limpando sessão corrompida e forçando reconexão...
🧹 Iniciando limpeza de sessão corrompida...
✅ 15 arquivos de sessão removidos (credenciais principais preservadas)
🔄 Aguardando 5 segundos antes de reconectar...
🔄 Reconectando após limpeza...
```

## ⚠️ Importante

1. **A interceptação do stderr é segura**: Não bloqueia outros logs
2. **Threshold reduzido**: Limpeza aciona mais rápido (5 erros em 3 min)
3. **Proteção contra loops**: Tratamento de erros evita loops infinitos
4. **Limpeza automática**: Continua preservando credenciais principais

## 🔍 Troubleshooting

### Se ainda aparecerem muitos erros Bad MAC:

1. **Verifique se o código foi atualizado**:
   ```bash
   grep -n "badMacErrorThreshold = 5" baileysBot.js
   ```

2. **Verifique se o bot foi reiniciado**:
   ```bash
   pm2 restart bot1
   ```

3. **Force limpeza manual se necessário**:
   ```bash
   pm2 stop bot1
   rm -rf tokens-bot1/session-* tokens-bot1/pre-key-* tokens-bot1/sender-key-*
   pm2 start bot1
   ```

### Se a interceptação causar problemas:

A interceptação foi projetada para ser segura, mas se houver problemas:

1. O código restaura stderr ao parar o bot
2. Pode ser desabilitada removendo o bloco de interceptação
3. Os handlers de eventos continuam funcionando normalmente

## 📈 Benefícios

1. ✅ **Captura todos os erros Bad MAC** (mesmo os do stderr)
2. ✅ **Aciona limpeza mais rápido** (5 erros em 3 min)
3. ✅ **Mais resiliente** (proteção contra chamadas prematuras)
4. ✅ **Seguro** (não bloqueia outros logs)
5. ✅ **Automático** (sem intervenção manual)

## 🎯 Resultado Esperado

Após aplicar esta solução:

- ✅ Erros Bad MAC serão detectados automaticamente
- ✅ Limpeza será acionada após 5 erros em 3 minutos
- ✅ Bot se recuperará automaticamente
- ✅ Não precisará intervenção manual na maioria dos casos

