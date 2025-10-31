const https = require('https');
const fs = require('fs');
const path = require('path');

/**
 * Serviço de Síntese de Voz (Gratuito)
 * Converte texto para áudio com voz humana usando Google TTS
 */
class AudioSynthesis {
    constructor() {
        this.cacheDir = path.join(__dirname, '..', 'cache_tts');
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
    }

    /**
     * Converte texto para áudio usando Google Text-to-Speech (gratuito)
     * @param {string} text - Texto a ser convertido
     * @param {string} lang - Idioma (pt-BR por padrão)
     * @param {number} speed - Velocidade da fala (0.25 a 4.0)
     * @returns {Promise<string>} Caminho do arquivo de áudio gerado
     */
    async textToSpeech(text, lang = 'pt-BR', speed = 1.0) {
        try {
            if (!text || !text.trim()) {
                throw new Error('Texto vazio');
            }

            // Limita tamanho do texto (Google TTS tem limite de ~5000 caracteres)
            const limitedText = text.substring(0, 5000);

            // Verifica cache
            const cacheKey = this.getCacheKey(limitedText, lang, speed);
            const cachedPath = path.join(this.cacheDir, cacheKey + '.ogg');
            
            if (fs.existsSync(cachedPath)) {
                console.log('✅ Usando áudio do cache');
                return cachedPath;
            }

            // Gera URL do Google TTS (gratuito, sem API key necessária)
            const ttsUrl = this.buildGoogleTTSUrl(limitedText, lang, speed);

            // Download do áudio
            const audioPath = await this.downloadAudio(ttsUrl, cachedPath);
            
            // Limpa cache antigo (mantém últimos 100 arquivos)
            this.cleanupCache();

            return audioPath;
        } catch (e) {
            console.error('❌ Erro ao gerar áudio:', e);
            throw e;
        }
    }

    /**
     * Faz download do áudio do Google TTS
     */
    async downloadAudio(url, outputPath) {
        return new Promise((resolve, reject) => {
            // Adiciona headers para simular navegador (melhora qualidade da voz)
            https.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'audio/webm,audio/ogg,audio/wav,*/*',
                    'Accept-Language': 'pt-BR,pt;q=0.9',
                    'Referer': 'https://translate.google.com/'
                }
            }, (response) => {
                if (response.statusCode !== 200) {
                    return reject(new Error(`HTTP ${response.statusCode}`));
                }

                const fileStream = fs.createWriteStream(outputPath);
                response.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close(() => {
                        console.log(`✅ Áudio gerado: ${path.basename(outputPath)}`);
                        resolve(outputPath);
                    });
                });

                fileStream.on('error', (err) => {
                    fs.unlinkSync(outputPath);
                    reject(err);
                });
            }).on('error', (err) => {
                reject(err);
            });
        });
    }

    /**
     * Gera chave de cache baseada no texto e parâmetros
     */
    getCacheKey(text, lang, speed) {
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update(`${text}_${lang}_${speed}`).digest('hex');
        return hash;
    }

    /**
     * Constrói URL do Google TTS com voz mais natural
     */
    buildGoogleTTSUrl(text, lang, speed) {
        // Google TTS gratuito via translate.google.com
        // Usa parâmetros para voz mais natural e humana
        const encodedText = encodeURIComponent(text);
        // Usa client=gtx para voz mais natural (ao invés de tw-ob)
        // Adiciona parâmetros para melhor qualidade
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=gtx&ttsspeed=${speed}&q=${encodedText}`;
        return url;
    }

    /**
     * Constrói URL alternativa para voz feminina brasileira natural
     */
    buildGoogleTTSUrlFemale(text) {
        // Tenta usar voz feminina brasileira (pt-BR-female)
        // O Google TTS gratuito usa voz feminina por padrão em pt-BR
        const encodedText = encodeURIComponent(text);
        // Usa parâmetros otimizados para voz humana
        // Usa velocidade 0.80 (mais lenta = mais natural e humana)
        // Usa client=gtx para melhor qualidade de áudio
        // pt-BR já usa voz feminina por padrão que é mais humana
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=pt-BR&client=gtx&ttsspeed=0.80&q=${encodedText}`;
        return url;
    }

    /**
     * Limpa arquivos antigos do cache, mantendo apenas os últimos 100
     */
    cleanupCache() {
        try {
            const files = fs.readdirSync(this.cacheDir)
                .map(file => ({
                    name: file,
                    path: path.join(this.cacheDir, file),
                    time: fs.statSync(path.join(this.cacheDir, file)).mtimeMs
                }))
                .sort((a, b) => b.time - a.time);

            // Remove arquivos além dos 100 mais recentes
            if (files.length > 100) {
                files.slice(100).forEach(file => {
                    try {
                        fs.unlinkSync(file.path);
                    } catch (_) {}
                });
            }
        } catch (e) {
            // Ignora erros de limpeza
        }
    }

    /**
     * Gera áudio com voz feminina brasileira natural (melhor para atendimento)
     * Usa parâmetros otimizados para soar mais humana
     */
    async textToSpeechFemale(text) {
        try {
            if (!text || !text.trim()) {
                throw new Error('Texto vazio');
            }

            const limitedText = text.substring(0, 5000);

            // Cache específico para voz feminina (usa 0.80 de velocidade)
            const cacheKey = this.getCacheKey(limitedText + '_female', 'pt-BR', 0.80);
            const cachedPath = path.join(this.cacheDir, cacheKey + '.ogg');
            
            if (fs.existsSync(cachedPath)) {
                console.log('✅ Usando áudio do cache (voz feminina)');
                return cachedPath;
            }

            // Usa URL otimizada para voz feminina natural
            const ttsUrl = this.buildGoogleTTSUrlFemale(limitedText);

            // Download do áudio
            const audioPath = await this.downloadAudio(ttsUrl, cachedPath);
            
            // Limpa cache antigo
            this.cleanupCache();

            return audioPath;
        } catch (e) {
            console.error('❌ Erro ao gerar áudio com voz feminina:', e);
            // Fallback para método padrão
            return await this.textToSpeech(text, 'pt-BR', 0.9);
        }
    }

    /**
     * Gera áudio com velocidade ajustada
     */
    async textToSpeechSlow(text, speed = 0.9) {
        return await this.textToSpeech(text, 'pt-BR', speed);
    }
}

module.exports = new AudioSynthesis();

