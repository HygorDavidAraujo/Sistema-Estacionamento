(function() {
    const normalizePlaca = (p) => (p || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:';
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    const defaultBase = window.BACKEND_BASE || (isLocal ? 'http://localhost:3000' : `${location.origin}/api`);
    let lastStatus = null;

    function setStatus(status) {
        lastStatus = status || null;
    }

    function getLastStatus() {
        return lastStatus;
    }

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

    function withTimeout(promise, ms) {
        return Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
        ]);
    }

    async function recognizePlateFromImage(imageBlob) {
        if (!imageBlob) return null;
        setStatus(null);
        const baseUrl = window.BACKEND_BASE || defaultBase;
        const endpoint = `${baseUrl}/placa/reconhecer`;
        try {
            const formData = new FormData();
            formData.append('image', imageBlob, 'capture.jpg');
            const res = await fetch(endpoint, { method: 'POST', body: formData, signal: timeoutSignal(6000) });
            if (!res.ok) throw new Error('Reconhecimento indisponível');
            const data = await res.json();
            if (data?.placa) {
                setStatus({ origem: data.origem || 'backend', mensagem: data.mensagem || '' });
                return normalizePlaca(data.placa);
            }
            if (data?.mensagem) setStatus({ origem: data.origem || 'backend', mensagem: data.mensagem });
        } catch (err) {
            console.warn('[plate.service] Falha ao reconhecer placa via backend:', err.message);
            setStatus({ origem: 'backend', mensagem: 'Falha no servidor de reconhecimento.' });
        }
        try {
            if (!isMobile && window.OcrService?.recognizePlateFromImage) {
                const placa = await withTimeout(window.OcrService.recognizePlateFromImage(imageBlob), 10000).catch(() => null);
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
        console.log('[plate.service] Consultando placa:', normalized, 'baseUrl:', baseUrl);
        try {
            const endpoint = `${baseUrl}/placa/${normalized}`;
            console.log('[plate.service] Endpoint:', endpoint);
            const res = await fetch(endpoint, { method: 'GET', signal: timeoutSignal(5000) });
            console.log('[plate.service] Status:', res.status);
            if (!res.ok) {
                console.warn('[plate.service] Resposta não OK:', res.status);
                return null;
            }
            const data = await res.json();
            console.log('[plate.service] Dados:', data);
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
        lookupPlateAPI,
        getLastStatus
    };
})();
