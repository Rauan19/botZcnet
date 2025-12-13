# 🔍 Análise: Heap Usage 80-89%

## ⚠️ Problema

Heap usage está entre 80-89% mesmo com lazy loading implementado.

## 🔍 Possíveis Causas

### 1. **Heap ainda pequeno (não aumentado)**

Se você está rodando via `npm run start:bot1` diretamente (não PM2), o heap padrão do Node pode ser pequeno (~10-50 MB).

**Solução:** Adicionar `--max-old-space-size` no script npm:

```json
"start:bot1": "cross-env WHATSAPP_PROVIDER=baileys PORT=3009 BAILEYS_SESSION_ID=bot1 node --max-old-space-size=4096 index.js"
```

### 2. **Módulos pesados ainda sendo carregados**

Mesmo com lazy loading, alguns módulos são carregados quando BaileysBot inicia:

- **contextAnalyzer.js** - Inicializa NLP no constructor (~20-30 MB)
- **Baileys** - Biblioteca de criptografia (~30-50 MB)
- **Express** - Servidor web (~10-20 MB)
- **SQLite** - Banco de dados (~10-20 MB)

**Total esperado:** ~70-120 MB

### 3. **Heap inicial pequeno**

Se o heap inicial for ~100 MB e você usar ~80 MB, o usage será 80%.

**Solução:** Aumentar heap para 4096 MB

## ✅ Verificação

### **1. Ver heap real do Node:**

Adicione no início do `index.js`:

```javascript
const v8 = require('v8');
const heapStats = v8.getHeapStatistics();
console.log('📊 Heap Statistics:');
console.log('  Total Heap Size:', Math.round(heapStats.total_heap_size / 1024 / 1024), 'MB');
console.log('  Used Heap Size:', Math.round(heapStats.used_heap_size / 1024 / 1024), 'MB');
console.log('  Heap Size Limit:', Math.round(heapStats.heap_size_limit / 1024 / 1024), 'MB');
console.log('  Heap Usage:', Math.round((heapStats.used_heap_size / heapStats.heap_size_limit) * 100), '%');
```

### **2. Verificar se heap está aumentado:**

Quando iniciar, deve mostrar:
```
Heap Size Limit: 4096 MB  ← Deve ser 4096, não ~100!
```

### **3. Ver processos Node:**

```bash
ps aux | grep node
```

Deve mostrar processo com `--max-old-space-size=4096`

## 🔧 Soluções

### **Solução 1: Aumentar heap no package.json**

```json
{
  "scripts": {
    "start:bot1": "cross-env WHATSAPP_PROVIDER=baileys PORT=3009 BAILEYS_SESSION_ID=bot1 node --max-old-space-size=4096 index.js"
  }
}
```

### **Solução 2: Usar PM2 com heap aumentado**

```bash
pm2 start index.js --name bot1 \
  --node-args="--max-old-space-size=4096" \
  --env WHATSAPP_PROVIDER=baileys \
  --env PORT=3009 \
  --env BAILEYS_SESSION_ID=bot1
```

### **Solução 3: Lazy loading do contextAnalyzer**

O `contextAnalyzer.js` inicializa NLP no constructor. Podemos fazer lazy loading também dele.

## 📊 Memória Esperada

### **Com Baileys apenas:**
- BaileysBot: ~50 MB
- Express: ~10 MB
- SQLite: ~10 MB
- ContextAnalyzer (NLP): ~20-30 MB
- **Total: ~90-100 MB**

### **Se heap for 4096 MB:**
- Heap Usage: ~2-3% ✅

### **Se heap for 100 MB (padrão):**
- Heap Usage: ~80-90% ⚠️ (mas ainda ok, só precisa aumentar)

## 🎯 Ação Imediata

**Atualize o package.json para aumentar heap:**

```json
"start:bot1": "cross-env WHATSAPP_PROVIDER=baileys PORT=3009 BAILEYS_SESSION_ID=bot1 node --max-old-space-size=4096 index.js"
```

Depois reinicie e verifique o heap usage deve cair para <5%!



