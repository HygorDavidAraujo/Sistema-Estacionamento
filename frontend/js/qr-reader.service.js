(function() {
    let scanning = false;
    let frameRequest = null;

    function ensureCanvas(canvas, width, height) {
        if (!canvas) return null;
        canvas.width = width;
        canvas.height = height;
        return canvas.getContext('2d');
    }

    async function start(videoEl, canvasEl, onResult) {
        await CameraService.startPreview(videoEl, { video: { facingMode: 'environment' } });
        scanning = true;
        const loop = () => {
            if (!scanning) return;
            const frame = CameraService.captureFrame(videoEl, canvasEl);
            if (frame && window.jsQR) {
                const code = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
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
