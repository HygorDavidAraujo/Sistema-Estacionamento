import { isValidPlate, normalizePlate, PlateServiceError, requestJson } from './plate-domain.js';

const clean = (value, max = 120) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export function vehicleResult(data, provider) {
    const vehicle = provider === 'simplesapi' ? data?.vehicle_info
        : provider === 'apiplacas' ? data?.basico?.dados : data;
    if (!vehicle || data.error || data?.basico?.error) throw new PlateServiceError('invalid_response', 'O serviço não retornou um cadastro válido.', 502);
    const result = {
        marca: clean(vehicle.brand || vehicle.marca),
        modelo: clean(vehicle.model || vehicle.modelo),
        cor: clean(vehicle.color || vehicle.cor, 60)
    };
    if (!result.marca && !result.modelo && !result.cor) throw new PlateServiceError('not_found', 'Nenhum dado encontrado para esta placa.', 404);
    return { ...result, completo: Boolean(result.marca && result.modelo && result.cor) };
}

export function createVehicleLookup({ repository = {}, env = process.env, fetchImpl, now = Date.now } = {}) {
    const provider = env.VEHICLE_LOOKUP_PROVIDER || 'parallelum';
    const ttl = Math.max(1, Math.min(Number(env.VEHICLE_CACHE_DAYS) || 30, 365)) * 86400000;
    const cache = new Map();
    const pending = new Map();
    let blockedUntil = 0;
    let blockedError = null;
    let quota = null;
    const configured = provider === 'parallelum' || (provider === 'simplesapi' && Boolean(env.SIMPLES_API_KEY)) || (provider === 'apiplacas' && Boolean(env.API_PLACAS_TOKEN));

    function remember(plate, data) {
        cache.delete(plate);
        if (cache.size >= 500) cache.delete(cache.keys().next().value);
        cache.set(plate, { data, expires: now() + ttl });
    }
    function found(plate, data, source) {
        return {
            placa: plate, encontrado: true, status: data.completo ? 'found' : 'partial',
            ...data, origem: source, fornecedor: provider,
            mensagem: data.completo ? '' : 'Cadastro parcial. Complete os campos que faltam.', cota: quota
        };
    }
    async function execute(plate) {
        let saved;
        try { saved = await repository.get?.(plate); } catch { /* Consulta externa continua se o cache persistente falhar. */ }
        if (saved && (!saved.expira_em || new Date(saved.expira_em).getTime() > now())) {
            const data = vehicleResult(saved, 'saved');
            if (data.completo) {
                remember(plate, { ...data, atualizadoEm: saved.atualizado_em || null });
                return found(plate, cache.get(plate).data, 'cache');
            }
        }
        if (!configured) throw new PlateServiceError('not_configured', 'A consulta cadastral precisa ser configurada. Preencha os dados manualmente.', 503);
        if (blockedUntil > now()) throw blockedError;
        let url;
        const options = { headers: {} };
        if (provider === 'parallelum') {
            url = `https://fipe.parallelum.com.br/api/v2/plates/${plate}`;
            if (env.FIPE_SUBSCRIPTION_TOKEN) options.headers['X-Subscription-Token'] = env.FIPE_SUBSCRIPTION_TOKEN;
        } else if (provider === 'simplesapi') {
            url = 'https://api.simplesapi.com.br/v1/vehicle/plate';
            options.method = 'POST';
            options.headers = { Authorization: `Bearer ${env.SIMPLES_API_KEY}`, 'Content-Type': 'application/json' };
            options.body = JSON.stringify({ plate });
        } else {
            url = `https://wdapi2.com.br/v3/basico/${plate}`;
            options.headers.Authorization = `Bearer ${env.API_PLACAS_TOKEN}`;
        }
        try {
            const { data, headers } = await requestJson(url, options, fetchImpl);
            const limit = headers.get('x-plate-quota-limit');
            const remaining = headers.get('x-plate-quota-remaining');
            if (limit !== null && remaining !== null) quota = { limite: Number(limit), restante: Number(remaining) };
            if (data?.plate && normalizePlate(data.plate) !== plate) throw new PlateServiceError('invalid_response', 'O serviço retornou dados de outra placa.', 502);
            const result = { ...vehicleResult(data, provider), atualizadoEm: new Date(now()).toISOString() };
            remember(plate, result);
            try {
                await repository.set?.(plate, result, provider, new Date(now() + ttl));
            } catch { /* O resultado continua disponível quando a persistência não está acessível. */ }
            return found(plate, result, 'api');
        } catch (error) {
            if (error.code === 'quota_exceeded' || error.code === 'credentials') {
                blockedUntil = now() + (error.details?.retryAfter || 600) * 1000;
                blockedError = error;
            }
            throw error;
        }
    }
    return {
        status: () => ({ fornecedor: provider, configurado: configured, cota: quota, limitado: blockedUntil > now(), gratuitoLimitado: provider === 'parallelum' }),
        lookup(rawPlate) {
            const plate = normalizePlate(rawPlate);
            if (!isValidPlate(plate)) return Promise.reject(new PlateServiceError('invalid_plate', 'Placa inválida. Use ABC1234 ou ABC1D23.', 400));
            const item = cache.get(plate);
            if (item && item.expires > now()) return Promise.resolve(found(plate, item.data, 'cache'));
            if (pending.has(plate)) return pending.get(plate);
            const work = execute(plate).finally(() => pending.delete(plate));
            pending.set(plate, work);
            return work;
        }
    };
}
