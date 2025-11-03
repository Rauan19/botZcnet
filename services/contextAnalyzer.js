// Importação do NLP - usa análise simples se NLP.js não estiver disponível
let NlpClass = null;
try {
    const nlpModule = require('@nlpjs/nlp');
    // @nlpjs/nlp exporta 'Nlp' (não 'NlpManager')
    if (nlpModule.Nlp) {
        NlpClass = nlpModule.Nlp;
    } else if (nlpModule.NlpManager) {
        NlpClass = nlpModule.NlpManager;
    } else if (nlpModule.default && nlpModule.default.Nlp) {
        NlpClass = nlpModule.default.Nlp;
    }
} catch (e) {
    console.warn('⚠️ @nlpjs/nlp não disponível, usando análise por palavras-chave');
}

const LangPt = require('@nlpjs/lang-pt');
const messageStore = require('../database');

/**
 * Sistema de Análise de Contexto Inteligente
 * Analisa múltiplas mensagens para entender a intenção do cliente
 */
class ContextAnalyzer {
    constructor() {
        this.nlp = null;
        this.isTrained = false;
        this.trainingPromise = null;
        
        // Tenta inicializar NLP se disponível
        if (NlpClass) {
            try {
                this.nlp = new NlpClass({ 
                    languages: ['pt'], 
                    forceNER: true,
                    nlu: { log: false },
                    autoSave: false
                });
                // Tenta usar LangPt se disponível
                try {
                    if (LangPt && typeof LangPt === 'function') {
                        this.nlp.use(LangPt);
                    } else if (LangPt && LangPt.default) {
                        this.nlp.use(LangPt.default);
                    } else if (LangPt && LangPt.LangPt) {
                        this.nlp.use(LangPt.LangPt);
                    }
                } catch (e) {
                    console.warn('⚠️ LangPt não disponível, continuando sem ele:', e.message);
                }
                
                // Inicia treinamento em background (não bloqueia)
                this.initializeNLP();
            } catch (e) {
                console.error('❌ Erro ao inicializar NLP:', e.message);
                this.nlp = null;
            }
        } else {
            console.warn('⚠️ Nlp não disponível, usando análise por palavras-chave apenas');
        }
    }

    /**
     * Inicializa e treina o NLP com padrões conhecidos
     */
    async initializeNLP() {
        if (!this.nlp) return Promise.resolve();
        if (this.trainingPromise) return this.trainingPromise;
        
        this.trainingPromise = this._train();
        return this.trainingPromise;
    }

    /**
     * Treina o NLP internamente
     */
    async _train() {
        if (!this.nlp) {
            this.isTrained = false;
            return;
        }
        // Padrões de solicitação de pagamento
        this.nlp.addDocument('pt', 'quero pagar', 'payment.request');
        this.nlp.addDocument('pt', 'preciso pagar', 'payment.request');
        this.nlp.addDocument('pt', 'manda boleto', 'payment.request');
        this.nlp.addDocument('pt', 'envia boleto', 'payment.request');
        this.nlp.addDocument('pt', 'quero boleto', 'payment.request');
        this.nlp.addDocument('pt', 'preciso do boleto', 'payment.request');
        this.nlp.addDocument('pt', 'manda pix', 'payment.request');
        this.nlp.addDocument('pt', 'envia pix', 'payment.request');
        this.nlp.addDocument('pt', 'quero pagar com pix', 'payment.request');
        this.nlp.addDocument('pt', 'pagar com pix', 'payment.request');
        this.nlp.addDocument('pt', 'quero pagar via pix', 'payment.request');
        this.nlp.addDocument('pt', 'preciso pagar com pix', 'payment.request');
        this.nlp.addDocument('pt', 'segunda via', 'payment.request');
        this.nlp.addDocument('pt', '2ª via', 'payment.request');
        this.nlp.addDocument('pt', 'como pago', 'payment.request');
        this.nlp.addDocument('pt', 'preciso pagar a internet', 'payment.request');
        this.nlp.addDocument('pt', 'quero pagar a internet', 'payment.request');

        // Padrões de confirmação de pagamento
        this.nlp.addDocument('pt', 'já paguei', 'payment.confirm');
        this.nlp.addDocument('pt', 'paguei', 'payment.confirm');
        this.nlp.addDocument('pt', 'fiz o pagamento', 'payment.confirm');
        this.nlp.addDocument('pt', 'realizei o pagamento', 'payment.confirm');

        // Padrões de informação sobre pagamento presencial
        this.nlp.addDocument('pt', 'vou passar aí', 'payment.presential');
        this.nlp.addDocument('pt', 'vou aí pagar', 'payment.presential');
        this.nlp.addDocument('pt', 'vou na loja pagar', 'payment.presential');
        this.nlp.addDocument('pt', 'amanhã vou pagar', 'payment.presential');
        this.nlp.addDocument('pt', 'vou pagar pessoalmente', 'payment.presential');

        // Padrões de conversa casual (deve ignorar)
        this.nlp.addDocument('pt', 'bom dia', 'casual.greeting');
        this.nlp.addDocument('pt', 'boa tarde', 'casual.greeting');
        this.nlp.addDocument('pt', 'boa noite', 'casual.greeting');
        this.nlp.addDocument('pt', 'olá', 'casual.greeting');
        this.nlp.addDocument('pt', 'oi', 'casual.greeting');
        this.nlp.addDocument('pt', 'oi tudo bem', 'casual.greeting');
        this.nlp.addDocument('pt', 'como você está', 'casual.greeting');
        this.nlp.addDocument('pt', 'tudo bem', 'casual.greeting');
        this.nlp.addDocument('pt', 'ok', 'casual.greeting');
        this.nlp.addDocument('pt', 'obrigado', 'casual.greeting');
        this.nlp.addDocument('pt', 'obrigada', 'casual.greeting');
        this.nlp.addDocument('pt', 'valeu', 'casual.greeting');
        this.nlp.addDocument('pt', 'beleza', 'casual.greeting');
        this.nlp.addDocument('pt', 'entendi', 'casual.greeting');
        this.nlp.addDocument('pt', 'blz', 'casual.greeting');
        this.nlp.addDocument('pt', 'ok entendi', 'casual.greeting');
        this.nlp.addDocument('pt', 'entendi obrigado', 'casual.greeting');

        // Respostas esperadas
        this.nlp.addAnswer('pt', 'payment.request', 'Oferecer boleto/PIX');
        this.nlp.addAnswer('pt', 'payment.confirm', 'Confirmar pagamento');
        this.nlp.addAnswer('pt', 'payment.presential', 'Ignorar mensagem');
        this.nlp.addAnswer('pt', 'casual.greeting', 'Ignorar conversa casual');

        // Treina o modelo
        try {
            await this.nlp.train();
            this.isTrained = true;
            console.log('✅ NLP treinado com sucesso');
        } catch (e) {
            console.error('⚠️ Erro ao treinar NLP, usando análise por palavras-chave:', e);
            this.isTrained = false;
        }
    }

    /**
     * Aguarda treinamento se necessário
     */
    async ensureTrained() {
        if (!this.isTrained && this.trainingPromise) {
            await this.trainingPromise;
        }
    }

    /**
     * Busca mensagens recentes do cliente (últimas 10 mensagens dos últimos 5 minutos)
     */
    async getRecentMessages(chatId, limitMinutes = 5, maxMessages = 10) {
        try {
            const chat = messageStore.getChat(chatId);
            if (!chat || !chat.messages) return [];

            const now = Date.now();
            const timeLimit = now - (limitMinutes * 60 * 1000);
            
            // Filtra mensagens do cliente (direction: 'in') dos últimos minutos
            const recent = chat.messages
                .filter(msg => 
                    msg.direction === 'in' && 
                    msg.timestamp >= timeLimit
                )
                .sort((a, b) => b.timestamp - a.timestamp) // Mais recentes primeiro
                .slice(0, maxMessages)
                .reverse(); // Ordena cronologicamente (mais antigas primeiro)

            return recent;
        } catch (e) {
            console.error('Erro ao buscar mensagens recentes:', e);
            return [];
        }
    }

    /**
     * Analisa o contexto de múltiplas mensagens
     */
    async analyzeContext(chatId, currentMessage) {
        try {
            // Busca mensagens recentes
            const recentMessages = await this.getRecentMessages(chatId);
            
            // Combina mensagens recentes com a mensagem atual
            const allMessages = [...recentMessages.map(m => m.text), currentMessage]
                .filter(text => text && text.trim());

            // Junta todas as mensagens em um contexto
            const contextText = allMessages.join(' ').toLowerCase();

            // Aguarda treinamento se necessário
            await this.ensureTrained();
            
            // Analisa com NLP (se treinado)
            let nlpResult = { score: 0, intent: null };
            if (this.nlp && this.isTrained) {
                try {
                    nlpResult = await this.nlp.process('pt', contextText);
                } catch (e) {
                    console.error('Erro ao processar com NLP:', e);
                }
            }
            
            // Análise de palavras-chave combinada
            // MAS analisa a mensagem ATUAL primeiro antes do contexto combinado
            const currentIntent = this.analyzeCombinedIntent(currentMessage.toLowerCase(), [currentMessage]);
            const contextIntent = this.analyzeCombinedIntent(contextText, allMessages);
            
            // Verifica se NLP detectou conversa casual
            if (nlpResult.intent === 'casual.greeting') {
                return {
                    intent: 'unclear', // Ignora conversas casuais
                    confidence: nlpResult.score || 0,
                    nlpIntent: nlpResult.intent,
                    messagesCount: allMessages.length,
                    contextText,
                    recentMessages: recentMessages.length
                };
            }
            
            // Se a mensagem atual tem intenção clara, usa ela (prioridade)
            // Só usa contexto se mensagem atual for unclear
            const intent = currentIntent !== 'unclear' ? currentIntent : contextIntent;

            return {
                intent,
                confidence: nlpResult.score || 0,
                nlpIntent: nlpResult.intent,
                messagesCount: allMessages.length,
                contextText,
                recentMessages: recentMessages.length
            };
        } catch (e) {
            console.error('Erro ao analisar contexto:', e);
            // Fallback para análise simples
            return {
                intent: this.analyzeSimpleIntent(currentMessage),
                confidence: 0.5,
                messagesCount: 1,
                contextText: currentMessage
            };
        }
    }

    /**
     * Analisa intenção combinada de múltiplas mensagens
     */
    analyzeCombinedIntent(contextText, messages) {
        const text = contextText.toLowerCase();

        // 1. Solicitação clara de boleto/PIX (PRIORIDADE MÁXIMA - se está pedindo AGORA, atende)
        const paymentRequests = [
            'quero pagar', 'preciso pagar', 'como pago', 'como faço para pagar',
            'manda boleto', 'envia boleto', 'quero boleto', 'preciso do boleto',
            'manda pix', 'envia pix', 'quero pix', 'preciso pix',
            'quero pagar com pix', 'pagar com pix', 'quero pagar via pix',
            'preciso pagar com pix', 'quero pagar no pix', 'pagar no pix',
            'segunda via', '2ª via', '2a via', 'segunda via do boleto',
            'boleto por favor', 'pix por favor', 'envia o boleto', 'manda o boleto',
            'preciso pagar a internet', 'quero pagar a internet',
            'fatura por favor', 'conta por favor', 'preciso da fatura',
            'quero pegar internet', 'preciso pegar internet'
        ];
        if (paymentRequests.some(kw => text.includes(kw))) {
            return 'request_payment';
        }
        
        // 1.9 PAGAMENTO COM PROBLEMA - "já paguei mas não liberou"
        const paymentDoneKeywords = ['já paguei', 'ja paguei', 'paguei', 'fiz o pagamento', 'realizei o pagamento', 'efetuei o pagamento', 'comprovante'];
        const paymentProblemKeywords = [
            'ainda n', 'ainda não', 'ainda nao', 'ainda não liberou', 'ainda nao liberou',
            'não liberou', 'nao liberou', 'n liberou', 'não funciona', 'nao funciona',
            'n funciona', 'não voltou', 'nao voltou', 'n voltou'
        ];
        const hasPaymentDone = paymentDoneKeywords.some(kw => text.includes(kw));
        const hasPaymentProblem = paymentProblemKeywords.some(kw => text.includes(kw));
        
        if (hasPaymentDone && hasPaymentProblem) {
            return 'support_paid_not_working';
        }
        
        // 2. Confirmação de pagamento (SEM problemas mencionados)
        const otherProblemIndicators = [
            'problema', 'erro', 'não deu certo', 'nao deu certo', 'n deu certo',
            'mas ainda', 'mas n', 'mas não', 'mas nao', 'porém ainda', 'porém não',
            'e ainda', 'e n', 'e não', 'e nao', 'mas não funciona', 'mas nao funciona'
        ];
        const hasOtherProblem = otherProblemIndicators.some(pi => text.includes(pi));
        
        // Se tem problema mas não é paymentProblem (mais genérico), retorna unclear
        if (hasOtherProblem && hasPaymentDone) {
            return 'unclear'; // Deixa para atendente humano
        }
        
        if (paymentDoneKeywords.some(kw => text.includes(kw))) {
            return 'confirm_payment';
        }

        // 2. Informação de pagamento presencial (ignorar)
        const presentialPayment = [
            'vou passar aí', 'vou aí', 'passo aí', 'vou aí pagar',
            'vou na loja', 'vou no estabelecimento', 'vou pagar pessoalmente',
            'vou no balcão', 'vou pagar na loja', 'amanhã vou pagar',
            'depois vou pagar', 'vou pagar depois', 'quando eu for aí',
            'quando eu passar aí', 'quando for aí'
        ];
        if (presentialPayment.some(kw => text.includes(kw))) {
            return 'inform_presential';
        }
        
        // 2.1 Problemas técnicos de internet - Internet lenta
        const slowInternetKeywords = [
            'internet lenta', 'internet muito lenta', 'está lenta', 'devagar',
            'wi-fi lento', 'wifi lento', 'wi fi lento', 'internet travando'
        ];
        if (slowInternetKeywords.some(kw => text.includes(kw))) {
            return 'support_slow';
        }
        
        // 2.2 Problemas técnicos de internet - Internet caiu
        const droppedInternetKeywords = [
            'internet caiu', 'internet cai', 'caiu a internet', 'sem internet',
            'internet parou', 'parou de funcionar', 'sem sinal', 'sem conexão',
            'wi-fi não funciona', 'wifi não funciona', 'wi fi não funciona'
        ];
        if (droppedInternetKeywords.some(kw => text.includes(kw))) {
            return 'support_dropped';
        }
        
        // 2.3 Problemas técnicos gerais
        const generalTechnicalIssues = [
            'wi-fi desconecta', 'wifi desconecta', 'desconectando',
            'problema com internet', 'internet dando problema',
            'repetidor', 'roteador', 'equipamento',
            'wi-fi travando', 'wifi travando'
        ];
        if (generalTechnicalIssues.some(kw => text.includes(kw))) {
            return 'support_technical';
        }

        // Detecção inteligente adicional para contexto combinado (só se ainda não detectou nada)
        // Se está analisando múltiplas mensagens, verifica padrões mais complexos
        if (messages.length >= 2) {
            const hasInternet = messages.some(m => m.toLowerCase().includes('internet') || m.toLowerCase().includes('serviço'));
            const hasPayWords = messages.some(m => {
                const mLower = m.toLowerCase();
                return ['pagar', 'pagamento', 'boleto', 'pix', 'fatura', 'conta'].some(w => mLower.includes(w));
            });
            
            // Palavras que indicam ação/solicitação (não apenas menção)
            const actionWords = ['preciso', 'quero', 'precisava', 'gostaria', 'desejo', 'manda', 'envia', 'como', 'onde'];
            const hasActionWord = messages.some(m => {
                const mLower = m.toLowerCase();
                return actionWords.some(aw => mLower.includes(aw));
            });

            // Só é solicitação se tiver: (internet OU serviço) + palavra de pagamento + palavra de ação
            if (hasInternet && hasPayWords && hasActionWord) {
                return 'request_payment';
            }
        }

        // 4. Detecção de solicitação implícita em múltiplas mensagens - MAIS RESTRITIVA
        // Só detecta como solicitação se houver padrões MUITO específicos de solicitação
        if (messages.length >= 2) {
            const combinedText = messages.map(m => m.trim()).join(' ').toLowerCase();
            
            // Padrões muito específicos que indicam claramente uma solicitação de pagamento
            const specificRequestPatterns = [
                // Padrões explícitos de solicitação
                /(preciso|quero|precisava).*?(pagar|boleto|pix|fatura).*?(internet|serviço)/i,
                /(como|onde).*?(pago|pagar|pagamento).*?(internet|serviço)/i,
                /(manda|envia).*?(boleto|pix|fatura)/i,
                /(segunda via|2.?a via).*?(boleto|fatura)/i,
                // Padrões com ação clara + objeto de pagamento
                /(oi|olá).*?(preciso|quero).*?(pagar|boleto|pix).*?(internet|serviço)/i
            ];

            // Só retorna request_payment se houver padrão específico de solicitação
            if (specificRequestPatterns.some(pattern => pattern.test(combinedText))) {
                return 'request_payment';
            }
            
            // Verifica se há MÚLTIPLAS palavras de ação + objeto de pagamento juntas
            // Ex: "preciso pagar internet" ou "quero boleto pix"
            const actionWords = ['preciso', 'quero', 'precisava', 'gostaria', 'desejo'];
            const paymentObjects = ['pagar', 'boleto', 'pix', 'fatura', 'conta'];
            const serviceWords = ['internet', 'serviço'];
            
            const hasAction = actionWords.some(aw => combinedText.includes(aw));
            const hasPaymentObj = paymentObjects.some(po => combinedText.includes(po));
            const hasService = serviceWords.some(sw => combinedText.includes(sw));
            
            // Só é solicitação se tiver ação + objeto de pagamento OU ação + serviço + palavra de pagamento
            // Isso evita falsos positivos em conversas normais
            if (hasAction && (hasPaymentObj || (hasService && hasPaymentObj))) {
                // Verifica se NÃO é apenas uma menção casual
                // Ignora se parecer apenas conversa casual
                const casualPatterns = [
                    /(só|apenas|também).*?(conversando|falando|dizendo)/i,
                    /(não|nunca).*?(paguei|pagar)/i,
                    /(vou|vou passar).*?(aí|loja|estabelecimento)/i
                ];
                
                if (!casualPatterns.some(pattern => pattern.test(combinedText))) {
                    return 'request_payment';
                }
            }
        }

        return 'unclear';
    }

    /**
     * Análise simples de intenção (fallback)
     */
    analyzeSimpleIntent(text) {
        if (!text) return 'unclear';
        const t = text.toLowerCase().trim();

        if (['já paguei', 'paguei', 'fiz o pagamento'].some(k => t.includes(k))) {
            return 'confirm_payment';
        }

        if (['vou passar aí', 'vou aí pagar', 'vou na loja'].some(k => t.includes(k))) {
            return 'inform_presential';
        }

        if (['quero pagar', 'preciso pagar', 'manda boleto', 'envia boleto'].some(k => t.includes(k))) {
            return 'request_payment';
        }

        return 'unclear';
    }
}

module.exports = new ContextAnalyzer();

