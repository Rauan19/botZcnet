const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
let ffmpegStaticPath = null;
try {
    ffmpegStaticPath = require('ffmpeg-static');
} catch (_) {
    ffmpegStaticPath = null;
}

const envFfmpegPath = process.env.FFMPEG_PATH || process.env.FFMPEG_BIN || null;
const resolvedFfmpegPath = envFfmpegPath || ffmpegStaticPath;
if (resolvedFfmpegPath && fs.existsSync(resolvedFfmpegPath)) {
    ffmpeg.setFfmpegPath(resolvedFfmpegPath);
    process.env.FFMPEG_PATH = resolvedFfmpegPath;
    const dir = path.dirname(resolvedFfmpegPath);
    if (!process.env.PATH.includes(dir)) {
        process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
    }
} else {
    console.warn('⚠️ ffmpeg não encontrado. Instale ffmpeg-static ou defina FFMPEG_PATH.');
}

async function convertToOpus(inputPath, outputPath) {
    if (!inputPath || !fs.existsSync(inputPath)) {
        throw new Error('Arquivo de origem não encontrado para conversão');
    }

    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioCodec('libopus')
            .audioBitrate('32k')
            .audioChannels(1)
            .audioFrequency(16000)
            .outputOptions('-vbr on')
            .format('ogg')
            .on('end', () => resolve(outputPath))
            .on('error', (err, stdout, stderr) => {
                console.error('ffmpeg stdout:', stdout);
                console.error('ffmpeg stderr:', stderr);
                reject(err);
            })
            .save(outputPath);
    });
}

async function sendPTT(client, chatId, audioPath) {
    if (!client || !client.pupPage) {
        throw new Error('Client do WhatsApp não está pronto');
    }
    if (!fs.existsSync(audioPath)) {
        throw new Error('Arquivo de áudio não encontrado para envio');
    }

    const page = client.pupPage;
    const normalizedChatId = chatId.includes('@') ? chatId : `${chatId}@c.us`;
    const phone = normalizedChatId.replace('@c.us', '').replace(/\D/g, '');

    console.log(`[sendPTT] Iniciando envio para ${normalizedChatId}, arquivo ${audioPath}`);

    await page.bringToFront();
    await page.goto(`https://web.whatsapp.com/send?phone=${phone}`, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('[sendPTT] Chat carregado, aguardando campo de mensagem...');

    await waitForAnySelector(page, [
        'div[role="textbox"][contenteditable="true"]',
        '#main div[contenteditable="true"]',
        'footer [contenteditable="true"]'
    ], { timeout: 60000 });
    console.log('[sendPTT] Campo de mensagem disponível');

    const clipSelectors = [
        'button[aria-label="Anexar"]',
        'button[data-icon="clip"]',
        'span[data-icon="clip"]',
        'div[title="Anexar"]',
        'button[aria-label="Menu de anexos"]',
        'button[aria-label="Attach"]',
        'button[aria-label="Attach file"]',
        'button[data-testid="attach-menu-plus"]',
        'div[data-testid="attach-menu-plus"]',
        'footer [data-testid="attach-menu-plus"]',
        'footer button[aria-haspopup="menu"]',
        'footer button span[data-icon="clip"]'
    ];

    console.log('[sendPTT] Tentando abrir menu de anexos...');

    const inputSelectors = [
        'input[type="file"][accept*="audio"]',
        'input[type="file"][accept*="video"]',
        'input[type="file"][data-attach=attach-media]',
        'input[type="file"]'
    ];

    let fileChooserPromise = null;
    try {
        await waitForAnySelector(page, clipSelectors, { timeout: 60000 });
        fileChooserPromise = page.waitForFileChooser({ timeout: 10000 });
        console.log('[sendPTT] FileChooser aguardando...');
    } catch (_) {
        console.log('[sendPTT] FileChooser imediato indisponível, fallback para input direto');
        fileChooserPromise = null;
    }

    await clickSelector(page, clipSelectors);
    console.log('[sendPTT] Menu de anexos clicado');

    if (fileChooserPromise) {
        try {
            const fileChooser = await fileChooserPromise;
            await fileChooser.accept([audioPath]);
            console.log('[sendPTT] Arquivo anexado via FileChooser');
        } catch (err) {
            console.warn('⚠️ FileChooser não disponível, tentando via input direto:', err.message);
            await attachViaInput(page, inputSelectors, audioPath);
        }
    } else {
        await attachViaInput(page, inputSelectors, audioPath);
        console.log('[sendPTT] Arquivo anexado via input direto');
    }

    const sendSelectors = [
        'button[aria-label="Enviar agora"]',
        'button[data-icon="send"]',
        'span[data-icon="send"]',
        'div[aria-label="Enviar"]'
    ];

    console.log('[sendPTT] Aguardando botão de envio...');

    await waitForAnySelector(page, sendSelectors, { timeout: 30000 });
    await clickSelector(page, sendSelectors);
    console.log('[sendPTT] Botão de envio clicado');

    await page.waitForTimeout(2000);

    console.log('[sendPTT] PTT enviado com sucesso');
    return { ok: true };
}

async function attachViaInput(page, selectors, audioPath) {
    const inputHandle = await waitForAnySelector(page, selectors, { timeout: 60000 });
    await inputHandle.uploadFile(audioPath);
    await inputHandle.dispose();
    console.log('[sendPTT] uploadFile concluído');
}

async function waitForAnySelector(page, selectors, options) {
    const mergedOptions = { timeout: 30000, ...options };
    const errors = [];
    for (const selector of selectors) {
        try {
            const handle = await page.waitForSelector(selector, mergedOptions);
            if (handle) {
                console.log(`[sendPTT] Selector encontrado: ${selector}`);
                return handle;
            }
        } catch (err) {
            errors.push({ selector, err });
        }
    }
    throw new Error(`Nenhum seletor encontrado: ${selectors.join(', ')} | ${errors.map(e => e.selector).join(', ')}`);
}

async function clickSelector(page, selectors) {
    const handle = await waitForAnySelector(page, selectors, { timeout: 60000 });
    await page.evaluate((element) => {
        const button = element.closest('button') || element;
        button.click();
    }, handle);
    await handle.dispose();
    console.log('[sendPTT] clickSelector executado');
}

module.exports = {
    convertToOpus,
    sendPTT
};

