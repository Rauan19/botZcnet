# 📋 Instruções - Imagem de Instruções PIX

## Como adicionar a imagem de instruções

Quando o bot enviar o código PIX (payload), ele também enviará automaticamente uma imagem com instruções de como copiar o código corretamente.

### Passos:

1. **Crie a pasta `images`** na raiz do projeto (se ainda não existir)
   - O código já cria automaticamente, mas você pode criar manualmente também

2. **Adicione a imagem** com o nome exato:
   - Nome do arquivo: `instrucoes_pix.png`
   - Caminho: `images/instrucoes_pix.png`

3. **Formato da imagem:**
   - Formato: PNG (preferencialmente) ou JPG
   - Tamanho recomendado: até 2MB
   - Dimensões: Qualquer (mas recomenda-se até 1080x1080px para melhor visualização no WhatsApp)

### O que acontece:

- ✅ **Se a imagem existir:** O bot envia a imagem com caption explicativo
- ⚠️ **Se a imagem NÃO existir:** O bot envia apenas uma mensagem de texto com as instruções

### Localização do arquivo:

```
bootZcNe4t/
├── images/
│   └── instrucoes_pix.png  ← Adicione a imagem aqui
├── whatsappBot.js
└── ...
```

### Mensagem enviada junto com a imagem:

```
📋 COMO COPIAR O CÓDIGO PIX:

✅ FORMA CORRETA:
1. Pressione e segure na mensagem do código
2. Selecione "Copiar" no menu
3. Cole no app do seu banco

❌ NÃO FAÇA:
• Não clique diretamente no código
• Não copie partes do código

⚠️ IMPORTANTE:
Copie o código COMPLETO, do início ao fim!
```

### Quando é enviado:

A imagem é enviada automaticamente **após** o bot enviar o código PIX (payload), sempre que:
- Cliente escolhe PIX como forma de pagamento
- Bot gera código PIX com sucesso
- Código PIX é enviado para o cliente

