(function() {
    let workerPromise = null;
    let worker = null;
    let generation = 0;
    let busy = false;

    function extractCandidates(text) {
        const tokens = String(text || '').toUpperCase().match(/[A-Z0-9]+/g) || [];
        const matches = [];
        const lines = String(text || '').toUpperCase().split(/\r?\n/).map(line => line.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
        for (let i = 0; i < lines.length - 1; i++) {
            if (lines[i].length === 3 && lines[i + 1].length === 4) tokens.push(lines[i] + lines[i + 1]);
        }
        if (tokens.length === 2 && tokens[0].length === 3 && tokens[1].length === 4) tokens.push(tokens.join(''));
        for (const token of tokens) {
            if (/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(token) && !matches.includes(token)) matches.push(token);
        }
        return matches;
    }

    async function getWorker(onProgress) {
        if (!window.Tesseract) throw new Error('A biblioteca de leitura não carregou. Confira sua conexão e recarregue a página.');
        if (!workerPromise) {
            const version = generation;
            workerPromise = window.Tesseract.createWorker('eng', 1, {
                logger: event => {
                    if (version === generation && onProgress && event.status !== 'recognizing text') onProgress('Preparando leitor gratuito…');
                }
            }).then(async instance => {
                if (version !== generation) {
                    await instance.terminate();
                    throw new DOMException('Leitura cancelada.', 'AbortError');
                }
                worker = instance;
                await instance.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', tessedit_pageseg_mode: '7' });
                return instance;
            }).catch(error => {
                if (version === generation) { workerPromise = null; worker = null; }
                throw error;
            });
        }
        return workerPromise;
    }

    function cancel() {
        generation++;
        const current = worker;
        worker = null;
        workerPromise = null;
        if (current) current.terminate().catch(() => {});
    }

    async function recognizePlateFromImage(image, { signal, onProgress, motorcycle = false, photo = false } = {}) {
        if (signal?.aborted) throw new DOMException('Leitura cancelada.', 'AbortError');
        if (busy) throw new Error('O leitor está terminando a captura anterior. Aguarde um instante.');
        busy = true;
        const version = generation;
        let timer;
        let abort;
        try {
            const interrupted = new Promise((_, reject) => {
                abort = () => { cancel(); reject(new DOMException('Leitura cancelada.', 'AbortError')); };
                signal?.addEventListener('abort', abort, { once: true });
                timer = setTimeout(() => { cancel(); reject(new Error('A leitura demorou. Aproxime a placa ou tente outra foto.')); }, 25000);
            });
            const recognize = async () => {
                const instance = await getWorker(onProgress);
                if (version !== generation || signal?.aborted) throw new DOMException('Leitura cancelada.', 'AbortError');
                await instance.setParameters({ tessedit_pageseg_mode: photo ? '11' : motorcycle ? '6' : '7' });
                onProgress?.('Lendo placa no dispositivo…');
                const { data } = await instance.recognize(image);
                if (version !== generation || signal?.aborted) throw new DOMException('Leitura cancelada.', 'AbortError');
                const candidates = extractCandidates(data?.text);
                if (!candidates.length) return null;
                return { placa: candidates[0], confianca: Math.max(0, Math.min(1, Number(data.confidence || 0) / 100)),
                    candidatos: candidates.map(placa => ({ placa })), origem: 'dispositivo', requerConfirmacao: true };
            };
            return await Promise.race([recognize(), interrupted]);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            busy = false;
        }
    }

    window.OcrService = { recognizePlateFromImage, extractCandidates, cancel };
})();
