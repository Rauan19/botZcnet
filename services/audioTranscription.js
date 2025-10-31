const fs = require('fs');
const path = require('path');
const https = require('https');
const { exec } = require('child_process');

/**
 * Serviço de Transcrição de Áudio (Gratuito)
 * Converte áudio de voz para texto usando APIs gratuitas
 */
class AudioTranscription {
    constructor() {
        // Cache de transcrições para evitar processar o mesmo áudio múltiplas vezes
        this.cache = new Map();
    }

    /**
     * Transcreve áudio para texto usando API gratuita do Google Speech Recognition
     * Requer arquivo de áudio convertido para formato aceito (FLAC, WAV)
     */
    async transcribe(audioPath) {
        try {
            // Verifica se já foi transcrito recentemente
            const cacheKey = this.getFileHash(audioPath);
            if (this.cache.has(cacheKey)) {
                return this.cache.get(cacheKey);
            }

            // Converte áudio para formato compatível (FLAC ou WAV 16kHz mono)
            const convertedPath = await this.convertAudio(audioPath);
            
            // Tenta transcrição usando diferentes métodos
            let transcript = null;

            // Método 1: Usa Whisper API gratuita via OpenAI (se tiver chave) ou local
            // Por enquanto, vamos usar uma solução mais simples

            // Método 2: Usa Google Speech-to-Text API (gratuita com limites generosos)
            transcript = await this.transcribeWithGoogle(convertedPath);

            // Se falhar, tenta método alternativo
            if (!transcript) {
                // Método 3: Usa Web Speech API via Puppeteer (gratuito, mas requer navegador)
                // Por enquanto, retornamos null e o bot pode processar como texto normal
                console.log('⚠️ Transcrição não disponível, processando áudio normalmente');
            }

            // Limpa arquivo convertido temporário
            if (convertedPath !== audioPath && fs.existsSync(convertedPath)) {
                try { fs.unlinkSync(convertedPath); } catch (_) {}
            }

            // Salva no cache
            if (transcript) {
                this.cache.set(cacheKey, transcript);
                // Limpa cache após 1 hora
                setTimeout(() => this.cache.delete(cacheKey), 3600000);
            }

            return transcript;
        } catch (e) {
            console.error('❌ Erro ao transcrever áudio:', e);
            return null;
        }
    }

    /**
     * Converte áudio para formato compatível (FLAC/WAV 16kHz mono)
     */
    async convertAudio(audioPath) {
        return new Promise((resolve, reject) => {
            const outputPath = audioPath + '.converted.flac';
            
            // Usa FFmpeg se disponível
            const ffmpeg = require('fluent-ffmpeg');
            const ffmpegStatic = require('ffmpeg-static');
            
            if (ffmpegStatic) {
                ffmpeg.setFfmpegPath(ffmpegStatic);
            }

            ffmpeg(audioPath)
                .toFormat('flac')
                .audioCodec('flac')
                .audioFrequency(16000)
                .audioChannels(1)
                .on('end', () => resolve(outputPath))
                .on('error', (err) => {
                    console.error('Erro ao converter áudio:', err);
                    // Se não conseguir converter, retorna o arquivo original
                    resolve(audioPath);
                })
                .save(outputPath);
        });
    }

    /**
     * Transcreve usando Google Speech-to-Text (gratuito com limites)
     * Nota: Requer configuração de credenciais, mas tem tier gratuito generoso
     * Por enquanto, retorna null - pode ser implementado depois
     */
    async transcribeWithGoogle(audioPath) {
        // TODO: Implementar quando necessário
        // Por enquanto, retorna null para não bloquear
        return null;
    }

    /**
     * Gera hash simples do arquivo para cache
     */
    getFileHash(filePath) {
        try {
            const stats = fs.statSync(filePath);
            return `${path.basename(filePath)}_${stats.size}_${stats.mtimeMs}`;
        } catch {
            return path.basename(filePath);
        }
    }

    /**
     * Processa áudio de mensagem do WhatsApp e retorna texto transcrito
     * @param {object} message - Objeto da mensagem
     * @param {object} client - Cliente wppconnect (opcional, será passado do bot)
     */
    async processWhatsAppAudio(message, client = null) {
        try {
            // Verifica se é mensagem de áudio
            if (!message.mimetype || !message.mimetype.includes('audio')) {
                return null;
            }

            // Se não tem client, não pode fazer download
            if (!client) {
                console.warn('⚠️ Cliente não disponível para download de áudio');
                return null;
            }

            // Faz download do áudio usando o client
            let media = null;
            try {
                // No wppconnect, usa client.downloadMedia(messageId)
                const messageId = message.id || message._serialized || message.timestamp;
                media = await client.downloadMedia(messageId);
                
                // Se retornar null, tenta outro método
                if (!media) {
                    // Tenta usar message.mediaData se disponível
                    if (message.mediaData) {
                        media = message.mediaData;
                    } else if (message.body && message.body.includes('data:')) {
                        // Se o body já contém base64
                        media = { data: message.body, mimetype: message.mimetype };
                    }
                }
            } catch (e) {
                console.warn('⚠️ Erro ao fazer download de mídia:', e.message);
                // Tenta usar dados da mensagem se disponíveis
                if (message.mediaData) {
                    media = message.mediaData;
                }
            }

            if (!media) {
                console.warn('⚠️ Não foi possível obter dados do áudio');
                return null;
            }

            // Salva temporariamente
            const tempDir = path.join(__dirname, '..', 'temp_audio');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            
            // Extrai dados base64 se necessário
            let audioData = media.data || media;
            let mimetype = media.mimetype || message.mimetype || 'audio/ogg';
            
            // Remove prefixo data URL se existir
            if (typeof audioData === 'string' && audioData.includes(',')) {
                audioData = audioData.split(',')[1];
            }
            
            const tempPath = path.join(tempDir, `audio_${Date.now()}.${this.getExtension(mimetype)}`);
            fs.writeFileSync(tempPath, Buffer.from(audioData, 'base64'));

            // Transcreve
            const transcript = await this.transcribe(tempPath);

            // Limpa arquivo temporário
            try { fs.unlinkSync(tempPath); } catch (_) {}

            return transcript;
        } catch (e) {
            console.error('❌ Erro ao processar áudio do WhatsApp:', e);
            return null;
        }
    }

    /**
     * Obtém extensão do arquivo baseado no mimetype
     */
    getExtension(mimetype) {
        if (mimetype.includes('ogg')) return 'ogg';
        if (mimetype.includes('mp3')) return 'mp3';
        if (mimetype.includes('wav')) return 'wav';
        if (mimetype.includes('m4a')) return 'm4a';
        return 'ogg';
    }
}

module.exports = new AudioTranscription();

