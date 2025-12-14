# 🔬 Análise Técnica: Heap PM2 vs Node Real

## 📋 Problema Identificado

Quando você executa `npm run start:bot1` através do PM2, você está criando uma **cadeia de processos** onde o PM2 monitora o processo **npm**, não o processo **Node** real.

## 🔍 Explicação Técnica Detalhada

### 1. **Por que isso acontece quando executo `npm run start:bot1`?**

```
PM2 → npm → node index.js
 │      │         │
 │      │         └─ Processo Node REAL (heap ~3120 MiB)
 │      │
 │      └─ Processo npm (heap ~8.7 MiB) ← PM2 MONITORA ESTE!
 │
 └─ PM2 só vê o processo npm, não o Node filho
```

**Cadeia de Execução:**
1. Você executa: `pm2 start "npm run start:bot1"`
2. PM2 cria processo: `npm run start:bot1`
3. npm cria processo filho: `node index.js`
4. **PM2 monitora apenas o processo npm (pai)**
5. O processo Node (filho) fica invisível para o PM2

**Resultado:**
- PM2 mostra métricas do npm (~8.7 MiB heap)
- Processo Node real tem heap de ~3120 MiB, mas PM2 não vê
- Heap usage aparece alto (80%+) porque compara uso contra heap pequeno do npm

### 2. **Por que o PM2 mostra métricas do processo npm, não do Node real?**

O PM2 usa `process.pid` e APIs do sistema operacional para monitorar processos. Quando você inicia um script npm:

```bash
pm2 start "npm run start:bot1"
```

O PM2:
- Cria processo com PID do npm
- Monitora esse PID específico
- Não consegue ver processos filhos (Node) criados pelo npm
- Coleta métricas apenas do processo npm

**Evidência:**
```bash
# Ver processos
ps aux | grep node

# Você verá:
# - Processo npm (PID 1234) ← PM2 monitora este
# - Processo node index.js (PID 5678) ← PM2 NÃO vê este
```

### 3. **Como isso limita o heap inicial do Node (~8 MiB)?**

**NÃO limita o heap do Node!** O heap do Node continua sendo ~3120 MiB. O problema é que:

1. **PM2 não consegue aplicar `--max-old-space-size` ao processo Node filho**
   - Quando você passa `node_args` no PM2, ele aplica ao processo que ele inicia diretamente
   - Se PM2 inicia npm, os `node_args` são aplicados ao npm (que não usa)
   - O processo Node filho herda heap padrão do sistema

2. **Heap do npm é pequeno (~8 MiB) porque:**
   - npm é um script wrapper leve
   - Não precisa de muito heap
   - Mas PM2 mostra métricas dele, não do Node

3. **Heap do Node real pode estar limitado se:**
   - Sistema operacional tem limite padrão baixo
   - Variáveis de ambiente não estão configuradas
   - Processo filho não herda configurações do pai

### 4. **Por que isso cria um falso alarme de Heap Usage alto?**

**Cálculo do Heap Usage:**
```
Heap Usage = (Used Heap / Heap Size) × 100%
```

**Com npm (falso):**
```
Heap Usage = (7 MiB / 8.7 MiB) × 100% = 80.5% ⚠️ ALTO!
```

**Com Node real (verdadeiro):**
```
Heap Usage = (7 MiB / 3120 MiB) × 100% = 0.22% ✅ NORMAL!
```

**O problema:**
- PM2 mostra heap usage de 80%+ porque compara uso contra heap pequeno do npm
- Na realidade, o Node está usando apenas 0.22% do heap disponível
- Isso cria um **falso alarme** de memória alta

## ✅ Solução: Rodar Node Diretamente

### 5. **Comandos Corretos para Corrigir**

#### **Parar e Remover Processo Atual:**

```bash
# Parar bot1
pm2 stop bot1

# Remover bot1 do PM2
pm2 delete bot1

# Limpar logs (opcional)
pm2 flush bot1
```

#### **Iniciar Bot Direto com Node:**

```bash
# Forma 1: Comando direto (recomendado)
pm2 start index.js --name bot1 \
  --node-args="--max-old-space-size=4096 --max-snapshots=1" \
  --env WHATSAPP_PROVIDER=baileys \
  --env PORT=3009 \
  --env BAILEYS_SESSION_ID=bot1 \
  --env BAILEYS_LOG_LEVEL=silent

# Forma 2: Usando ecosystem.config.js (já configurado corretamente)
pm2 start ecosystem.config.js --only bot1
```

#### **Verificar se Está Correto:**

```bash
# Ver detalhes do processo
pm2 describe bot1

# Deve mostrar:
# - interpreter: node (não npm!)
# - node_args: --max-old-space-size=4096
# - script: index.js (não npm run start:bot1)

# Ver heap real
pm2 describe bot1 | grep -E "heap|memory"
# Agora deve mostrar heap de ~3120 MiB ou mais
```

### 6. **Forma Recomendada de Rodar no PM2**

O `ecosystem.config.js` já está configurado corretamente! Use:

```bash
# Iniciar todos os bots
pm2 start ecosystem.config.js

# Ou iniciar bot específico
pm2 start ecosystem.config.js --only bot1
pm2 start ecosystem.config.js --only bot2
pm2 start ecosystem.config.js --only bot3
```

**Por que funciona:**
- `script: 'index.js'` → PM2 inicia Node diretamente
- `interpreter: 'node'` → Garante que usa Node, não npm
- `node_args: '--max-old-space-size=4096'` → Aplicado ao processo Node real
- PM2 monitora o processo Node diretamente

## 📊 Comparação Visual

### ❌ **ERRADO (via npm):**
```
PM2 → npm → node index.js
 │      │         │
 │      │         └─ Heap: 3120 MiB (PM2 não vê)
 │      │
 │      └─ Heap: 8.7 MiB ← PM2 mostra este!
 │
 └─ Heap Usage: 80%+ (FALSO ALARME!)
```

### ✅ **CORRETO (Node direto):**
```
PM2 → node index.js
 │         │
 │         └─ Heap: 4096 MiB ← PM2 mostra este!
 │
 └─ Heap Usage: <1% (CORRETO!)
```

## 🔧 Verificação e Diagnóstico

### **Verificar qual processo o PM2 está monitorando:**

```bash
# Ver PID do processo
pm2 describe bot1 | grep pid

# Ver processo real no sistema
ps aux | grep $(pm2 describe bot1 | grep pid | awk '{print $2}')

# Se mostrar "npm", está ERRADO
# Se mostrar "node index.js", está CORRETO
```

### **Verificar heap real do Node:**

```bash
# Dentro do código Node, adicionar:
console.log('Heap Total:', v8.getHeapStatistics().heap_size_limit / 1024 / 1024, 'MiB');
console.log('Heap Used:', v8.getHeapStatistics().used_heap_size / 1024 / 1024, 'MiB');

# Ou usar:
node -e "console.log(require('v8').getHeapStatistics())"
```

## 🎯 Resumo Executivo

| Aspecto | Via npm | Via Node Direto |
|---------|---------|-----------------|
| **Processo Monitorado** | npm (~8 MiB) | Node (~4096 MiB) |
| **Heap Real do Node** | ~3120 MiB (não visto) | ~4096 MiB (visto) |
| **Heap Usage Mostrado** | 80%+ (falso) | <1% (correto) |
| **node_args Aplicados** | ❌ Não | ✅ Sim |
| **Métricas Precisas** | ❌ Não | ✅ Sim |

## ⚠️ Importante

1. **NUNCA use `pm2 start "npm run start:bot1"`**
2. **SEMPRE use `pm2 start ecosystem.config.js` ou `pm2 start index.js`**
3. **Verifique sempre com `pm2 describe bot1` se está usando Node direto**
4. **O heap real do Node pode ser diferente do mostrado pelo PM2 se usar npm**

## 📝 Comandos Finais Recomendados

```bash
# 1. Parar e remover processos antigos
pm2 stop all
pm2 delete all

# 2. Limpar logs
pm2 flush

# 3. Iniciar com configuração correta
pm2 start ecosystem.config.js

# 4. Verificar
pm2 list
pm2 describe bot1 | grep -E "interpreter|node_args|script"

# 5. Salvar
pm2 save
```




