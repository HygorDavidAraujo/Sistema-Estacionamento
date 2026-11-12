(function() {
    const streams = new Map();
    const generations = new Map();

    function normalizeVideoSize(video) {
        if (!video) return { width: 640, height: 480 };
        const w = video.videoWidth || 640;
        const h = video.videoHeight || 480;
        return { width: w, height: h };
    }

    async function startPreview(videoEl, constraints = { video: { facingMode: 'environment' } }, options = {}) {
        if (!videoEl) throw new Error('Vídeo não encontrado.');
        const isSecure = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        if (!isSecure) {
            throw new Error('Acesso à câmera requer HTTPS (ou localhost).');
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('Câmera não suportada neste dispositivo.');
        }
        if (videoEl) {
            videoEl.setAttribute('playsinline', '');
            videoEl.setAttribute('autoplay', '');
            videoEl.setAttribute('muted', '');
            videoEl.playsInline = true;
            videoEl.autoplay = true;
            videoEl.muted = true;
        }
        stopPreview(videoEl);
        const version = generations.get(videoEl);
        let permissionTimer;
        const permission = navigator.mediaDevices.getUserMedia({ ...constraints, audio: false }).then(stream => {
            if (generations.get(videoEl) !== version) {
                stream.getTracks().forEach(track => track.stop());
                throw new DOMException('Abertura da câmera cancelada.', 'AbortError');
            }
            return stream;
        });
        let stream;
        try {
            stream = await Promise.race([permission, new Promise((_, reject) => {
                permissionTimer = setTimeout(() => {
                    if (generations.get(videoEl) === version) stopPreview(videoEl);
                    reject(new Error('A câmera não respondeu. Confira a permissão do navegador ou envie uma foto.'));
                }, 15000);
            })]);
        } finally { clearTimeout(permissionTimer); }
        videoEl.srcObject = stream;
        streams.set(videoEl, stream);
        try {
            await videoEl.play();
            if (options.waitForReady !== false) await waitForReady(videoEl, options.readyTimeout || 5000);
        } catch (err) {
            if (generations.get(videoEl) === version) stopPreview(videoEl);
            throw err;
        }
        const zoomValue = typeof options.zoom === 'number' ? options.zoom : null;
        if (zoomValue && zoomValue > 0) {
            await applyZoom(videoEl, zoomValue).catch(() => {});
        }
        return stream;
    }

    async function applyZoom(videoEl, zoomValue) {
        const stream = streams.get(videoEl) || videoEl?.srcObject;
        const track = stream?.getVideoTracks?.()[0];
        if (!track || !track.getCapabilities || !track.applyConstraints) return false;
        const caps = track.getCapabilities();
        if (!caps || caps.zoom == null) return false;
        const minZoom = caps.zoom.min ?? zoomValue;
        const maxZoom = caps.zoom.max ?? zoomValue;
        const targetZoom = Math.min(Math.max(zoomValue, minZoom), maxZoom);
        await track.applyConstraints({ advanced: [{ zoom: targetZoom }] });
        return true;
    }

    function waitForReady(videoEl, timeoutMs = 2000) {
        return new Promise((resolve, reject) => {
            if (!videoEl) return reject(new Error('Vídeo não encontrado'));
            if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0 && videoEl.readyState >= 2) {
                return resolve();
            }

            const onReady = () => {
                if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0 && videoEl.readyState >= 2) {
                    cleanup();
                    resolve();
                }
            };

            const cleanup = () => {
                videoEl.removeEventListener('loadedmetadata', onReady);
                videoEl.removeEventListener('loadeddata', onReady);
                videoEl.removeEventListener('playing', onReady);
                clearTimeout(tid);
            };

            const tid = setTimeout(() => {
                cleanup();
                if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) return resolve();
                reject(new Error('Câmera não ficou pronta a tempo'));
            }, timeoutMs);

            videoEl.addEventListener('loadedmetadata', onReady);
            videoEl.addEventListener('loadeddata', onReady);
            videoEl.addEventListener('playing', onReady);
        });
    }

    function stopPreview(videoEl) {
        if (!videoEl) return;
        generations.set(videoEl, (generations.get(videoEl) || 0) + 1);
        const stream = streams.get(videoEl) || videoEl?.srcObject;
        if (stream && stream.getTracks) {
            stream.getTracks().forEach(t => t.stop());
        }
        videoEl.srcObject = null;
        streams.delete(videoEl);
    }

    function stopAll() {
        Array.from(generations.keys()).forEach(stopPreview);
    }

    function captureFrame(videoEl, canvasEl) {
        if (!videoEl) return null;
        const { width, height } = normalizeVideoSize(videoEl);
        const canvas = canvasEl || document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(videoEl, 0, 0, width, height);
        return ctx.getImageData(0, 0, width, height);
    }

    function captureBlob(videoEl, type = 'image/jpeg', quality = 0.92) {
        const { width, height } = normalizeVideoSize(videoEl);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(videoEl, 0, 0, width, height);
        return new Promise((resolve, reject) => {
            canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Falha ao capturar imagem.')), type, quality);
        });
    }

    window.CameraService = {
        startPreview,
        stopPreview,
        stopAll,
        captureFrame,
        captureBlob,
        applyZoom,
        waitForReady
    };
})();
