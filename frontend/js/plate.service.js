(function() {
    const normalizePlaca = (p) => (p || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:';
    const defaultBase = window.BACKEND_BASE || (isLocal ? 'http://localhost:3000' : `${location.origin}/api`);

    function timeoutSignal(ms) {
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
            return AbortSignal.timeout(ms);
        }
        if (typeof AbortController !== 'undefined') {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), ms);
            return controller.signal;
        }
        return undefined;
    }

    async function recognizePlateFromImage(imageBlob) {
        if (!imageBlob) return null;
        const baseUrl = window.BACKEND_BASE || defaultBase;
        const endpoint = `${baseUrl}/placa/reconhecer`;
        try {
            const formData = new FormData();
            formData.append('image', imageBlob, 'capture.jpg');
            const res = await fetch(endpoint, { method: 'POST', body: formData, signal: timeoutSignal(6000) });
            if (!res.ok) throw new Error('Reconhecimento indisponível');
            const data = await res.json();
            if (data?.placa) return normalizePlaca(data.placa);
        } catch (err) {
            console.warn('[plate.service] Falha ao reconhecer placa via backend:', err.message);
        }
        try {
            if (window.OcrService?.recognizePlateFromImage) {
                const placa = await window.OcrService.recognizePlateFromImage(imageBlob);
                if (placa) return normalizePlaca(placa);
            }
        } catch (err) {
            console.warn('[plate.service] OCR local falhou:', err.message);
        }
        return null;
    }

    async function lookupPlateAPI(placa) {
        const normalized = normalizePlaca(placa);
        if (!normalized) return null;
        const baseUrl = window.BACKEND_BASE || defaultBase;
        try {
            const res = await fetch(`${baseUrl}/placa/${normalized}`, { method: 'GET', signal: timeoutSignal(5000) });
            if (!res.ok) return null;
            const data = await res.json();
            if (data.error) return null;
            return {
                encontrado: data.encontrado !== false,
                marca: data.marca || '',
                modelo: data.modelo || '',
                cor: data.cor || '',
                mensagem: data.mensagem || '',
                origem: data.origem || 'api'
            };
        } catch (err) {
            console.warn('[plate.service] Erro ao consultar placa:', err.message);
            return null;
        }
    }

    window.PlateService = {
        normalizePlaca,
        recognizePlateFromImage,
        lookupPlateAPI
    };
})();
