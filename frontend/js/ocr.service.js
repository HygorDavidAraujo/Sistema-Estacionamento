(function() {
    let workerPromise = null;

    function ensureTesseract() {
        if (!window.Tesseract) {
            throw new Error('Tesseract.js não carregado');
        }
    }

    function getWorker() {
        if (!workerPromise) {
            ensureTesseract();
            workerPromise = (async () => {
                const worker = await Tesseract.createWorker({
                    logger: () => {}
                });
                await worker.loadLanguage('eng');
                await worker.initialize('eng');
                await worker.setParameters({
                    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
                    preserve_interword_spaces: '1'
                });
                return worker;
            })();
        }
        return workerPromise;
    }

    function normalizePlate(text) {
        return String(text || '').replace(/[^A-Z0-9]/g, '').toUpperCase();
    }

    function extractPlate(text) {
        const clean = normalizePlate(text);
        if (!clean) return null;
        const mercosul = clean.match(/[A-Z]{3}[0-9][A-Z][0-9]{2}/);
        if (mercosul) return mercosul[0];
        const antigo = clean.match(/[A-Z]{3}[0-9]{4}/);
        if (antigo) return antigo[0];
        return null;
    }

    async function recognizePlateFromImage(imageBlob) {
        if (!imageBlob) return null;
        try {
            const worker = await getWorker();
            const { data } = await worker.recognize(imageBlob);
            const candidate = extractPlate(data?.text || '');
            if (candidate) return candidate;
        } catch (err) {
            console.warn('[ocr.service] OCR falhou:', err.message);
        }
        return null;
    }

    window.OcrService = {
        recognizePlateFromImage
    };
})();
