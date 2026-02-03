(function() {
    const streams = new WeakMap();

    function normalizeVideoSize(video) {
        if (!video) return { width: 640, height: 480 };
        const w = video.videoWidth || 640;
        const h = video.videoHeight || 480;
        return { width: w, height: h };
    }

    async function startPreview(videoEl, constraints = { video: { facingMode: 'environment' } }, options = {}) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('Câmera não suportada neste dispositivo.');
        }
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        videoEl.srcObject = stream;
        streams.set(videoEl, stream);
        await videoEl.play().catch(() => {});
        if (options.waitForReady !== false) {
            await waitForReady(videoEl, options.readyTimeout || 2000).catch(() => {});
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
        const stream = streams.get(videoEl) || videoEl?.srcObject;
        if (stream && stream.getTracks) {
            stream.getTracks().forEach(t => t.stop());
        }
        videoEl.srcObject = null;
        streams.delete(videoEl);
    }

    function stopAll() {
        streams.forEach((stream, videoEl) => {
            if (stream && stream.getTracks) stream.getTracks().forEach(t => t.stop());
            if (videoEl) videoEl.srcObject = null;
        });
        streams.clear();
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
