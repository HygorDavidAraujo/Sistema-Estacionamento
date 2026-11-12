(function() {
    const element = id => document.getElementById(id);
    let session = 0;
    let operation = null;
    let timer = null;
    let attempts = 0;
    let cloudEnabled = false;
    let torch = false;
    let objectUrl = null;

    function status(message) { element('entradaCameraStatus').textContent = message; }
    function setBusy(value) {
        element('capturarPlacaBtn').disabled = value;
        element('capturarPlacaBtn').textContent = value ? 'Lendo placa…' : 'Capturar placa';
        element('cameraEntradaContainer').setAttribute('aria-busy', String(value));
    }
    function stopOperation() {
        clearTimeout(timer);
        timer = null;
        operation?.abort();
        operation = null;
    }
    function clearReview() {
        element('plateReview').hidden = true;
        element('plateCandidates').replaceChildren();
        if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
        element('plateCapturePreview').removeAttribute('src');
    }
    function close() {
        session++;
        stopOperation();
        CameraService.stopPreview(element('entradaCameraPreview'));
        element('cameraEntradaContainer').setAttribute('aria-hidden', 'true');
        element('fecharCameraEntradaBtn').setAttribute('aria-hidden', 'true');
        clearReview();
        setBusy(false);
    }

    function cameraError(error) {
        if (['NotAllowedError', 'SecurityError'].includes(error.name)) return 'Permita o acesso à câmera nas configurações do navegador. Você também pode enviar uma foto.';
        if (error.name === 'NotFoundError') return 'Nenhuma câmera encontrada. Use a opção Enviar foto.';
        if (error.name === 'NotReadableError') return 'A câmera está ocupada. Feche outros aplicativos e tente novamente.';
        return error.message || 'Não foi possível abrir a câmera.';
    }

    async function open(deviceId) {
        close();
        window.fecharCameraSaida?.();
        const version = session;
        const video = element('entradaCameraPreview');
        element('cameraEntradaContainer').setAttribute('aria-hidden', 'false');
        element('fecharCameraEntradaBtn').setAttribute('aria-hidden', 'false');
        status('Abrindo câmera…');
        attempts = 0;
        torch = false;
        cloudEnabled = false;
        element('cameraEntradaContainer').classList.remove('photo-mode');
        try {
            const selection = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
            let stream;
            try {
                stream = await CameraService.startPreview(video, { video: { ...selection, width: { ideal: 1920 }, height: { ideal: 1080 } } });
            } catch (error) {
                if (error.name !== 'OverconstrainedError') throw error;
                stream = await CameraService.startPreview(video, { video: selection });
            }
            if (version !== session) { stream.getTracks().forEach(track => track.stop()); return; }
            const track = stream.getVideoTracks()[0];
            const caps = track.getCapabilities?.() || {};
            if (caps.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
            if (version !== session) return;
            element('cameraTorchBtn').hidden = !caps.torch;
            element('cameraTorchBtn').textContent = 'Ligar lanterna';
            const zoom = element('cameraZoom');
            zoom.closest('label').hidden = !caps.zoom;
            if (caps.zoom) {
                zoom.min = caps.zoom.min;
                zoom.max = caps.zoom.max;
                zoom.step = caps.zoom.step || 0.1;
                zoom.value = track.getSettings?.().zoom || caps.zoom.min;
            }
            const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
            if (version !== session) return;
            const select = element('cameraDevice');
            select.replaceChildren();
            devices.filter(device => device.kind === 'videoinput').forEach((device, index) => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `Câmera ${index + 1}`;
                option.selected = track.getSettings?.().deviceId === device.deviceId;
                select.appendChild(option);
            });
            status('Centralize a placa na moldura e mantenha o aparelho firme.');
            PlateService.getServices().then(result => { if (version === session) cloudEnabled = Boolean(result.camera?.nuvem); });
            schedule(version, 1500);
        } catch (error) {
            if (version === session) status(cameraError(error));
        }
    }

    function cropGeometry(video, guide) {
        const box = video.getBoundingClientRect();
        const area = guide.getBoundingClientRect();
        const factor = Math.max(box.width / video.videoWidth, box.height / video.videoHeight);
        const offsetX = (box.width - video.videoWidth * factor) / 2;
        const offsetY = (box.height - video.videoHeight * factor) / 2;
        const x = Math.max(0, (area.left - box.left - offsetX) / factor);
        const y = Math.max(0, (area.top - box.top - offsetY) / factor);
        return { x, y, width: Math.min(area.width / factor, video.videoWidth - x), height: Math.min(area.height / factor, video.videoHeight - y) };
    }

    function sharpness(canvas) {
        const sample = document.createElement('canvas');
        sample.width = Math.min(320, canvas.width);
        sample.height = Math.max(1, Math.round(canvas.height * sample.width / canvas.width));
        const ctx = sample.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(canvas, 0, 0, sample.width, sample.height);
        const pixels = ctx.getImageData(0, 0, sample.width, sample.height).data;
        let total = 0;
        let count = 0;
        for (let y = 1; y < sample.height - 1; y += 2) {
            for (let x = 1; x < sample.width - 1; x += 2) {
                const i = (y * sample.width + x) * 4;
                total += Math.abs(2 * pixels[i] - pixels[i - 4] - pixels[i + 4]);
                count++;
            }
        }
        return total / Math.max(1, count);
    }

    function localImage(canvas) {
        const processed = document.createElement('canvas');
        const scale = Math.min(2, Math.max(1, 1000 / canvas.width));
        processed.width = Math.round(canvas.width * scale);
        processed.height = Math.round(canvas.height * scale);
        const ctx = processed.getContext('2d');
        ctx.filter = 'grayscale(1) contrast(1.25)';
        ctx.drawImage(canvas, 0, 0, processed.width, processed.height);
        return processed;
    }

    async function bestFrame(video, signal) {
        let best = null;
        let score = -1;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');
            const crop = cropGeometry(video, element('plateGuide'));
            if (crop.width < 50 || crop.height < 15) throw new Error('A câmera ainda não está pronta. Tente novamente.');
            const canvas = document.createElement('canvas');
            const scale = Math.min(1, 1600 / crop.width);
            canvas.width = Math.round(crop.width * scale);
            canvas.height = Math.round(crop.height * scale);
            canvas.getContext('2d').drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
            const current = sharpness(canvas);
            if (current > score) { best = canvas; score = current; }
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 120));
        }
        return best;
    }

    function schedule(version, delay = 2000) {
        clearTimeout(timer);
        if (version !== session || !element('entradaCameraPreview').srcObject || attempts >= 3 || document.hidden) return;
        timer = setTimeout(() => capture(true), delay);
    }

    function showResult(result, blob) {
        clearTimeout(timer);
        element('plateReview').hidden = false;
        element('plateDetectedInput').value = result.placa;
        const confidence = Number.isFinite(result.confianca) ? ` · ${Math.round(result.confianca * 100)}% de confiança do leitor` : '';
        element('plateReadSource').textContent = `Leitura ${result.origem === 'nuvem' ? 'na nuvem' : 'no dispositivo'}${confidence}. Confira os sete caracteres.`;
        const alternatives = element('plateCandidates');
        alternatives.replaceChildren();
        (result.candidatos || []).slice(1, 4).forEach(candidate => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn-ghost';
            button.textContent = candidate.placa;
            button.onclick = () => { element('plateDetectedInput').value = candidate.placa; };
            alternatives.appendChild(button);
        });
        objectUrl = URL.createObjectURL(blob);
        element('plateCapturePreview').src = objectUrl;
        status('Leitura concluída. Confirme a placa abaixo.');
    }

    async function capture(automatic = false, file = null) {
        if (operation) return;
        const version = session;
        const controller = new AbortController();
        operation = controller;
        clearTimeout(timer);
        clearReview();
        setBusy(true);
        attempts++;
        try {
            let canvas;
            if (file) {
                if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 12 * 1024 * 1024) throw new Error('Escolha uma foto JPEG, PNG ou WebP de até 12 MB.');
                const bitmap = await createImageBitmap(file);
                try {
                    canvas = document.createElement('canvas');
                    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
                    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
                    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
                    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                } finally { bitmap.close(); }
            } else {
                canvas = await bestFrame(element('entradaCameraPreview'), controller.signal);
            }
            if (version !== session || controller.signal.aborted) return;
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.94));
            if (!blob) throw new Error('Não foi possível capturar a imagem. Tente novamente.');
            const result = await PlateService.recognizePlateFromImage(blob, {
                signal: controller.signal, localImage: localImage(canvas), cloudEnabled,
                motorcycle: element('cameraMotorcycle').checked, photo: Boolean(file),
                onProgress: message => { if (version === session) status(message); }
            });
            if (version !== session || controller.signal.aborted) return;
            if (result) showResult(result, blob);
            else {
                const last = PlateService.getLastStatus();
                if (last?.stopCloud) cloudEnabled = false;
                status(last?.mensagem || 'Aproxime a placa, ajuste a iluminação e capture novamente.');
                if (automatic) schedule(version);
            }
        } catch (error) {
            if (version === session && error.name !== 'AbortError') status(error.message || 'Falha ao capturar a placa.');
        } finally {
            if (operation === controller) operation = null;
            if (version === session) setBusy(false);
        }
    }

    function accept() {
        const plate = PlateService.normalizePlaca(element('plateDetectedInput').value);
        if (!PlateService.isValidPlaca(plate)) { status('Confira a placa: use ABC1234 ou ABC1D23.'); return; }
        const input = element('placaEntrada');
        input.value = plate;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        close();
        element('marcaEntrada').focus();
    }

    function bind() {
        document.querySelector('label[for="platePhotoInput"]').addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); element('platePhotoInput').click(); }
        });
        element('cameraDevice').addEventListener('change', event => open(event.target.value));
        element('cameraZoom').addEventListener('input', event => CameraService.applyZoom(element('entradaCameraPreview'), Number(event.target.value)).catch(() => status('Não foi possível ajustar o zoom.')));
        element('cameraTorchBtn').addEventListener('click', async () => {
            const track = element('entradaCameraPreview').srcObject?.getVideoTracks()[0];
            if (!track) return;
            try {
                await track.applyConstraints({ advanced: [{ torch: !torch }] });
                torch = !torch;
                element('cameraTorchBtn').textContent = torch ? 'Desligar lanterna' : 'Ligar lanterna';
            } catch { status('A lanterna não está disponível nesta câmera.'); }
        });
        element('cameraMotorcycle').addEventListener('change', event => {
            element('plateGuide').classList.toggle('motorcycle', event.target.checked);
            stopOperation();
            clearReview();
            setBusy(false);
            attempts = 0;
        });
        element('acceptPlateBtn').addEventListener('click', accept);
        element('retryPlateBtn').addEventListener('click', () => {
            if (element('entradaCameraPreview').srcObject) capture();
            else element('platePhotoInput').click();
        });
        element('platePhotoInput').addEventListener('change', async event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            close();
            element('cameraEntradaContainer').setAttribute('aria-hidden', 'false');
            element('cameraEntradaContainer').classList.add('photo-mode');
            element('fecharCameraEntradaBtn').setAttribute('aria-hidden', 'false');
            status('Preparando foto…');
            const version = session;
            const settings = await PlateService.getServices();
            if (version !== session) return;
            cloudEnabled = Boolean(settings.camera?.nuvem);
            await capture(false, file);
        });
        document.addEventListener('visibilitychange', () => { if (document.hidden) close(); });
        window.addEventListener('pagehide', close);
    }

    window.PlateCamera = { open, close, capture, bind, cropGeometry };
})();
