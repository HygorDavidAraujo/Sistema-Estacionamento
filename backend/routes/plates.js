import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { createVehicleLookup } from '../services/vehicle-lookup.js';
import { imageType, isValidPlate, normalizePlate, PlateServiceError, requestJson } from '../services/plate-domain.js';

export function recognitionCandidates(data) {
    return (Array.isArray(data?.results) ? data.results : [])
        .flatMap((result) => [
            { plate: result.plate, score: result.score }, ...(result.candidates || [])
        ])
        .map((item) => ({ placa: normalizePlate(item.plate), confianca: Number(item.score) }))
        .filter((item) => isValidPlate(item.placa) && Number.isFinite(item.confianca) && item.confianca >= 0.65 && item.confianca <= 1)
        .sort((a, b) => b.confianca - a.confianca)
        .filter((item, index, all) => all.findIndex((other) => other.placa === item.placa) === index)
        .slice(0, 5);
}

function limiter(max) {
    const entries = new Map();
    return (req, res, next) => {
        const now = Date.now();
        const key = req.ip;
        let item = entries.get(key);
        if (!item || item.until < now) {
            if (entries.size >= 1000) for (const [ip, value] of entries) { if (value.until < now || entries.size >= 1000) entries.delete(ip); }
            item = { count: 0, until: now + 60000 };
            entries.set(key, item);
        }
        if (++item.count > max) {
            res.set('Retry-After', String(Math.ceil((item.until - now) / 1000)));
            return res.status(429).json({ status: 'rate_limited', mensagem: 'Muitas tentativas. Aguarde um minuto antes de tentar novamente.' });
        }
        next();
    };
}

export function createPlateRouter({ repository, env = process.env, fetchImpl, auth = (_req, _res, next) => next() } = {}) {
    const router = express.Router();
    const lookup = createVehicleLookup({ repository, env, fetchImpl });
    const providerUrl = env.ANPR_URL || (env.ANPR_API_KEY ? 'https://api.platerecognizer.com/v1/plate-reader/' : '');
    const cloudEnabled = Boolean(providerUrl && env.ANPR_API_KEY);
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 0 } });

    router.get('/health', (_req, res) => res.json({ success: true, service: 'estacionamento' }));
    router.get('/servicos/placas', auth, (_req, res) => res.json({
        consulta: lookup.status(), camera: { local: true, nuvem: cloudEnabled, fornecedor: cloudEnabled ? 'platerecognizer' : null }
    }));
    router.get('/placa/:placa', auth, limiter(30), async (req, res, next) => {
        try { res.json(await lookup.lookup(req.params.placa)); } catch (error) { next(error); }
    });
    router.post('/placa/reconhecer', auth, limiter(12), upload.single('image'), async (req, res, next) => {
        const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', abort);
        try {
            if (!req.file) throw new PlateServiceError('invalid_image', 'Selecione uma imagem JPEG, PNG ou WebP.', 400);
            const type = imageType(req.file.buffer);
            if (!type) throw new PlateServiceError('invalid_image', 'O arquivo não é uma imagem JPEG, PNG ou WebP válida.', 415);
            if (!cloudEnabled) throw new PlateServiceError('not_configured', 'Leitura na nuvem desativada. Use a leitura gratuita no dispositivo.', 503);
            const form = new FormData();
            form.append('upload', new Blob([req.file.buffer], { type }), 'placa.jpg');
            form.append('regions', 'br');
            const { data } = await requestJson(providerUrl, {
                method: 'POST', headers: { Authorization: `Token ${env.ANPR_API_KEY}` }, body: form, signal: controller.signal
            }, fetchImpl, 10000);
            const candidates = recognitionCandidates(data);
            if (!candidates.length) return res.json({ placa: null, status: 'not_found', mensagem: 'Placa não identificada. Ajuste a posição ou digite manualmente.' });
            const best = candidates[0];
            res.json({ ...best, candidatos: candidates, origem: 'nuvem', requerConfirmacao: true, status: best.confianca >= 0.9 ? 'found' : 'review' });
        } catch (error) { next(error); }
        finally { res.off('close', abort); }
    });
    router.use((error, _req, res, _next) => {
        const requestId = randomUUID();
        const tooLarge = error.code === 'LIMIT_FILE_SIZE';
        const uploadError = error instanceof multer.MulterError;
        const status = tooLarge ? 413 : uploadError ? 400 : error.status || 503;
        if (error.details?.retryAfter) res.set('Retry-After', String(error.details.retryAfter));
        if (!res.headersSent && !res.destroyed) res.status(status).json({
            encontrado: false, placa: null, status: tooLarge ? 'image_too_large' : uploadError ? 'invalid_image' : error.code || 'provider_unavailable',
            mensagem: tooLarge ? 'A imagem deve ter no máximo 4 MB.' : uploadError ? 'Envie apenas uma imagem no campo image.' : error.message,
            requestId
        });
    });
    return router;
}
