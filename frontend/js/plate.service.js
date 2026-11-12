(function() {
    const normalizePlaca = value => String(value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const isValidPlaca = value => /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(normalizePlaca(value));
    let lastStatus = null;
    let services = null;
    let servicesAt = 0;

    function baseUrl() {
        const local = ['localhost', '127.0.0.1'].includes(location.hostname) || location.protocol === 'file:';
        return window.BACKEND_BASE || (local ? 'http://localhost:3000' : `${location.origin}/api`);
    }
    async function request(path, { signal, timeout = 15000, ...options } = {}) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (signal?.aborted) controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, timeout);
        try {
            const headers = new Headers(options.headers || {});
            const token = localStorage.getItem('adminToken');
            if (token) headers.set('x-admin-token', token);
            const response = await fetch(`${baseUrl()}${path}`, { ...options, headers, signal: controller.signal });
            const data = await response.json().catch(() => null);
            if (!response.ok) return { encontrado: false, status: data?.status || 'unavailable', mensagem: data?.mensagem || data?.error || 'Serviço indisponível. Preencha manualmente.' };
            if (!data || typeof data !== 'object') return { encontrado: false, status: 'invalid_response', mensagem: 'Resposta inesperada do servidor.' };
            return data;
        } catch (error) {
            if (signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
            return { encontrado: false, status: controller.signal.aborted ? 'timeout' : 'offline',
                mensagem: controller.signal.aborted ? 'A consulta demorou. Você pode preencher os dados manualmente.' : 'Sem conexão com o servidor. Confira sua conexão.' };
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        }
    }

    async function getServices({ refresh = false } = {}) {
        if (!refresh && services && Date.now() - servicesAt < 60000) return services;
        const result = await request('/servicos/placas', { timeout: 5000 });
        if (result.camera && result.consulta) { services = result; servicesAt = Date.now(); }
        return result;
    }

    async function recognizePlateFromImage(image, options = {}) {
        lastStatus = null;
        let localError = null;
        try {
            const local = await window.OcrService.recognizePlateFromImage(options.localImage || image, options);
            if (local) return local;
        } catch (error) {
            if (error.name === 'AbortError' || options.signal?.aborted) throw error;
            localError = error.message;
        }
        if (options.signal?.aborted) throw new DOMException('Leitura cancelada.', 'AbortError');
        if (options.cloudEnabled) {
            options.onProgress?.('Tentando leitura na nuvem…');
            const form = new FormData();
            form.append('image', image, 'placa.jpg');
            const result = await request('/placa/reconhecer', { method: 'POST', body: form, signal: options.signal, timeout: 15000 });
            if (result.placa && isValidPlaca(result.placa)) return { ...result, placa: normalizePlaca(result.placa) };
            lastStatus = result;
            if (['quota_exceeded', 'credentials', 'not_configured', 'rate_limited'].includes(result.status)) lastStatus.stopCloud = true;
        } else {
            lastStatus = { status: 'not_found', mensagem: localError || 'Não consegui ler os sete caracteres. Aproxime a placa e tente capturar novamente.' };
        }
        return null;
    }

    async function lookupPlateAPI(value, options = {}) {
        const plate = normalizePlaca(value);
        if (!isValidPlaca(plate)) return { encontrado: false, status: 'invalid_plate', mensagem: 'Use uma placa no formato ABC1234 ou ABC1D23.' };
        return request(`/placa/${plate}`, { signal: options.signal });
    }

    window.PlateService = { normalizePlaca, isValidPlaca, lookupPlateAPI, recognizePlateFromImage, getServices, getLastStatus: () => lastStatus };
})();
