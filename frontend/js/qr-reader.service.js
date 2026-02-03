(function() {
    let scanning = false;
    let frameRequest = null;
    let loadPromise = null;
    const CDN_PRIMARY = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
    const CDN_FALLBACK = 'https://unpkg.com/jsqr@1.4.0/dist/jsQR.js';

    function injectScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('Falha ao carregar ' + src));
            document.head.appendChild(s);
        });
    }

    function ensureJsQRLoaded() {
        if (window.jsQR) return Promise.resolve();
        if (!loadPromise) {
            loadPromise = injectScript(CDN_PRIMARY).catch(() => injectScript(CDN_FALLBACK));
        }
        return loadPromise.then(() => {
            if (!window.jsQR) throw new Error('Biblioteca jsQR não carregada');
        });
    }

    function ensureCanvas(canvas, width, height) {
        if (!canvas) return null;
        canvas.width = width;
        canvas.height = height;
        return canvas.getContext('2d');
    }

    function waitForVideoReady(videoEl, timeoutMs = 2000) {
        return new Promise((resolve, reject) => {
            if (!videoEl) return reject(new Error('Vídeo não encontrado'));
            if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) return resolve();

            const onReady = () => {
                if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
                    cleanup();
                    resolve();
                }
            };

            const cleanup = () => {
                videoEl.removeEventListener('loadedmetadata', onReady);
                clearTimeout(tid);
            };

            const tid = setTimeout(() => {
                cleanup();
                if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) return resolve();
                reject(new Error('Câmera não ficou pronta a tempo'));
            }, timeoutMs);

            videoEl.addEventListener('loadedmetadata', onReady);
        });
    }

    async function start(videoEl, canvasEl, onResult) {
        await ensureJsQRLoaded();
        try {
            await CameraService.startPreview(videoEl, { video: { facingMode: 'environment' } }, { zoom: 2 });
        } catch (err) {
            await CameraService.startPreview(videoEl, { video: true }, { zoom: 2 });
        }
        await waitForVideoReady(videoEl).catch(() => {});
        scanning = true;
        const loop = () => {
            if (!scanning) return;
            const frame = CameraService.captureFrame(videoEl, canvasEl);
            if (frame && frame.width > 0 && frame.height > 0 && window.jsQR) {
                const code = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'attemptBoth' });
                if (code && code.data) {
                    scanning = false;
                    stop(videoEl);
                    if (typeof onResult === 'function') onResult(code.data.trim());
                    return;
                }
            }
            frameRequest = requestAnimationFrame(loop);
        };
        loop();
    }

    function stop(videoEl) {
        scanning = false;
        if (frameRequest) cancelAnimationFrame(frameRequest);
        frameRequest = null;
        CameraService.stopPreview(videoEl);
    }

    function bindKeyboardInput(inputEl, onResult) {
        if (!inputEl) return;
        let buffer = '';
        let timer = null;

        const flush = () => {
            if (!buffer.trim()) return;
            const value = buffer.trim();
            buffer = '';
            inputEl.value = '';
            if (typeof onResult === 'function') onResult(value);
        };

        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                flush();
            }
        });

        inputEl.addEventListener('input', () => {
            buffer = inputEl.value;
            clearTimeout(timer);
            timer = setTimeout(flush, 200);
        });
    }

    window.QrReaderService = { start, stop, bindKeyboardInput };
})();
