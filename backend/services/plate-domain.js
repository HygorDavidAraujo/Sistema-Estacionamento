import fetch from 'node-fetch';

export const normalizePlate = (value) => String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
export const isValidPlate = (value) => /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(value);

export class PlateServiceError extends Error {
    constructor(code, message, status = 503, details = {}) {
        super(message);
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

export async function requestJson(url, options = {}, fetchImpl = fetch, timeoutMs = 8000) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const parent = options.signal;
    if (parent?.aborted) controller.abort();
    parent?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
        const response = await fetchImpl(url, {
            ...options, signal: controller.signal, size: 2 * 1024 * 1024,
            headers: { Accept: 'application/json', ...options.headers }
        });
        if (!response.ok) {
            response.body?.destroy?.();
            const status = response.status;
            if (status === 404 || status === 422) throw new PlateServiceError('not_found', 'Nenhum dado encontrado para esta placa.', 404);
            if (status === 401 || status === 403) throw new PlateServiceError('credentials', 'O serviço de placas precisa de uma credencial válida. Avise o responsável.', 503);
            if (status === 402) throw new PlateServiceError('quota_exceeded', 'O saldo do serviço de placas está esgotado. Você pode preencher manualmente.', 503);
            if (status === 429) {
                const seconds = Number(response.headers.get('retry-after'));
                throw new PlateServiceError('quota_exceeded', 'A cota de consultas foi atingida. Os veículos já salvos continuam disponíveis.', 429,
                    { retryAfter: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 2678400) : 3600 });
            }
            throw new PlateServiceError('provider_unavailable', 'O serviço de placas está indisponível. Tente novamente mais tarde.', 503);
        }
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('json')) throw new PlateServiceError('invalid_response', 'O serviço de placas retornou uma resposta inesperada.', 502);
        let data;
        try { data = await response.json(); }
        catch (error) {
            if (controller.signal.aborted) throw error;
            throw new PlateServiceError('invalid_response', 'O serviço de placas retornou dados inválidos.', 502);
        }
        return { data, headers: response.headers };
    } catch (error) {
        if (error instanceof PlateServiceError) throw error;
        if (controller.signal.aborted) throw new PlateServiceError(parent?.aborted ? 'cancelled' : 'timeout', 'A leitura demorou além do esperado. Tente novamente.', 504);
        throw new PlateServiceError('provider_unavailable', 'Não foi possível conectar ao serviço de placas.', 503);
    } finally {
        clearTimeout(timer);
        parent?.removeEventListener('abort', abort);
    }
}

export function imageType(buffer) {
    if (!buffer || buffer.length < 12) return null;
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
}
