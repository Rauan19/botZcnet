# 🔧 Solução para Erros "Bad MAC" em Produção

## 📋 Problema

Após alguns dias em produção, o bot começava a apresentar múltiplos erros "Bad MAC" do libsignal:

```
Session error:Error: Bad MAC Error: Bad MAC
    at Object.verifyMAC (/novobot1/botZcnet/node_modules/libsignal/src/crypto.js:87:15)
    at SessionCipher.doDecryptWhisperMessage
```

### Causas Identificadas

1. **Sessões desatualizadas**: Após alguns dias, as sessões de criptografia ficam desatualizadas
2. **Corrupção de dados**: Arquivos de sessão podem ficar corrompidos após uso prolongado
3. **Múltiplas instâncias**: Conflito quando múltiplas instâncias tentam usar a mesma sessão
4. **Tokens inválidos**: Tokens de sessão podem expirar ou ficar inválidos

## ✅ Solução Implementada

### 1. **Monitoramento de Erros Bad MAC**

- Contador de erros consecutivos
- Janela de tempo de 5 minutos para contar erros
- Limite configurável (padrão: 10 erros)

### 2. **Limpeza Automática de Sessão**

Quando o limite de erros é atingido:
- Remove apenas arquivos de sessão específicos (não credenciais principais)
- Preserva `creds.json`, `keys.json` e arquivos críticos
- Força reconexão automática após limpeza
- Reseta contadores de erro

### 3. **Limpeza Periódica Preventiva**

- Executa a cada 6 horas
- Remove sessões antigas (>7 dias sem uso)
- Protege arquivos críticos
- Previne acúmulo de sessões corrompidas

### 4. **Tratamento Robusto de Erros**

- Captura erros Bad MAC em múltiplos pontos:
  - Processamento de mensagens
  - Descriptografia de mensagens
  - Erros do socket
- Logs detalhados para diagnóstico
- Continua funcionando mesmo com erros isolados

## 🔄 Como Funciona

### Fluxo de Tratamento de Erros

```
Erro Bad MAC detectado
    ↓
Incrementa contador
    ↓
Verifica se atingiu limite (10 erros em 5 min)
    ↓
Se SIM → Limpa sessão e reconecta
Se NÃO → Continua operação normal
```

### Limpeza Automática

Quando ativada:
1. Para o bot atual
2. Fecha conexão existente
3. Remove apenas arquivos de sessão específicos:
   - `session-*`
   - `pre-key-*`
   - `sender-key-*`
   - `app-state-sync-key-*` (exceto o principal)
   - `app-state-sync-version-*` (exceto o principal)
4. **Preserva** arquivos críticos:
   - `creds.json`
   - `keys.json`
   - `app-state-sync-key.json`
   - `app-state-sync-version.json`
5. Aguarda 5 segundos
6. Reconecta automaticamente

## 📊 Configurações

### Variáveis de Ambiente

```bash
# ID da sessão (obrigatório para múltiplas instâncias)
BAILEYS_SESSION_ID=bot1

# Porta do servidor
PORT=3009

# Nível de log do Baileys (opcional)
BAILEYS_LOG_LEVEL=fatal
```

### Parâmetros Ajustáveis no Código

```javascript
// Limite de erros antes de limpar sessão
this.badMacErrorThreshold = 10;

// Janela de tempo para contar erros (5 minutos)
this.badMacErrorWindow = 5 * 60 * 1000;

// Idade máxima de sessões para limpeza periódica (7 dias)
const maxAge = 7 * 24 * 60 * 60 * 1000;
```

## 🚀 Benefícios

1. **Auto-recuperação**: Bot se recupera automaticamente de sessões corrompidas
2. **Prevenção**: Limpeza periódica previne acúmulo de sessões antigas
3. **Resiliência**: Continua funcionando mesmo com erros isolados
4. **Segurança**: Preserva credenciais principais durante limpeza
5. **Diagnóstico**: Logs detalhados facilitam troubleshooting

## 📝 Logs Esperados

### Erro Bad MAC Normal (isolado)
```
❌ ERRO Bad MAC detectado ao processar mensagem!
📊 Contador de erros: 1/10
💡 Limpeza automática será acionada após 9 erros adicionais
```

### Limite Atingido (limpeza automática)
```
⚠️⚠️⚠️ LIMITE DE ERROS BAD MAC ATINGIDO ⚠️⚠️⚠️
   10 erros em 300 segundos
🔄 Limpando sessão corrompida e forçando reconexão...
🧹 Iniciando limpeza de sessão corrompida...
✅ 15 arquivos de sessão removidos (credenciais principais preservadas)
🔄 Aguardando 5 segundos antes de reconectar...
🔄 Reconectando após limpeza...
```

### Limpeza Periódica
```
🧹 Limpeza periódica: 3 sessões antigas removidas
```

## ⚠️ Importante

1. **NUNCA** rode múltiplas instâncias com o mesmo `BAILEYS_SESSION_ID`
2. **SEMPRE** use `BAILEYS_SESSION_ID` diferente para cada bot
3. A limpeza automática preserva credenciais principais
4. O bot pode precisar escanear QR novamente após limpeza completa (raro)

## 🔍 Troubleshooting

### Se erros continuarem após limpeza automática:

1. Verifique se há múltiplas instâncias rodando:
   ```bash
   pm2 list
   ```

2. Verifique se cada bot usa `BAILEYS_SESSION_ID` diferente:
   ```bash
   pm2 env bot1 | grep BAILEYS_SESSION_ID
   ```

3. Limpe manualmente se necessário:
   ```bash
   pm2 stop bot1
   rm -rf tokens-bot1/session-* tokens-bot1/pre-key-* tokens-bot1/sender-key-*
   pm2 start bot1
   ```

4. Se persistir, pode ser necessário limpar tudo e reautenticar:
   ```bash
   pm2 stop bot1
   rm -rf tokens-bot1/*
   pm2 start bot1
   # Escaneie QR code novamente
   ```

## 📈 Monitoramento

Monitore os logs para verificar:
- Frequência de erros Bad MAC
- Ativação de limpeza automática
- Sucesso da reconexão após limpeza
- Limpeza periódica funcionando

```bash
pm2 logs bot1 --lines 100 | grep -E "Bad MAC|limpeza|reconectando"
```

