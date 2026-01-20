(function() {
    const streams = new WeakMap();

    function normalizeVideoSize(video) {
        if (!video) return { width: 640, height: 480 };
        const w = video.videoWidth || 640;
        const h = video.videoHeight || 480;
        return { width: w, height: h };
    }

    async function startPreview(videoEl, constraints = { video: { facingMode: 'environment' } }) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('Câmera não suportada neste dispositivo.');
        }
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        videoEl.srcObject = stream;
        streams.set(videoEl, stream);
        await videoEl.play().catch(() => {});
        return stream;
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
        captureBlob
    };
})();
