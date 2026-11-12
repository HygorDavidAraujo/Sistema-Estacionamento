import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createPlateRouter } from '../routes/plates.js';

async function serverFor(t, options) {
    const app = express();
    app.use(createPlateRouter(options));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return `http://127.0.0.1:${server.address().port}`;
}
const image = () => new Blob([Buffer.from([255, 216, 255, 224, 0, 1, 2, 3, 4, 5, 6, 7])], { type: 'image/jpeg' });
function form(file = image()) { const result = new FormData(); result.append('image', file, 'plate.jpg'); return result; }

test('rota de consulta funciona sobre HTTP com resposta normalizada', async t => {
    let calls = 0;
    const base = await serverFor(t, { env: {}, fetchImpl: async () => { calls++; return Response.json({ brand: 'Marca', model: 'Modelo', color: 'Prata' }); } });
    const first = await fetch(`${base}/placa/ABC1D23`);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).cor, 'Prata');
    await fetch(`${base}/placa/ABC1D23`);
    assert.equal(calls, 1);
});

test('câmera sem nuvem é diagnosticada sem falso sucesso ou placa simulada', async t => {
    const base = await serverFor(t, { env: { ANPR_FAKE_PLATE: 'ABC1D23' } });
    const services = await (await fetch(`${base}/servicos/placas`)).json();
    assert.deepEqual(services.camera, { local: true, nuvem: false, fornecedor: null });
    const response = await fetch(`${base}/placa/reconhecer`, { method: 'POST', body: form() });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).status, 'not_configured');
});

test('reconhecimento usa região Brasil, candidatos válidos e confirmação', async t => {
    let body;
    const base = await serverFor(t, { env: { ANPR_API_KEY: 'secret' }, fetchImpl: async (_url, options) => {
        body = options.body;
        assert.equal(options.headers.Authorization, 'Token secret');
        return Response.json({ results: [{ plate: 'invalid', score: 0.99 }, { plate: 'abc1d23', score: 0.95, candidates: [{ plate: 'abc1023', score: 0.8 }] }] });
    } });
    const response = await fetch(`${base}/placa/reconhecer`, { method: 'POST', body: form() });
    const result = await response.json();
    assert.equal(body.get('regions'), 'br');
    assert.equal(result.placa, 'ABC1D23');
    assert.equal(result.confianca, 0.95);
    assert.equal(result.requerConfirmacao, true);
});

test('arquivo falso e upload grande retornam JSON e não alcançam fornecedor', async t => {
    const base = await serverFor(t, { env: { ANPR_API_KEY: 'secret' }, fetchImpl: () => assert.fail('Fornecedor não deveria receber arquivo') });
    const invalid = await fetch(`${base}/placa/reconhecer`, { method: 'POST', body: form(new Blob(['not an image'], { type: 'image/jpeg' })) });
    assert.equal(invalid.status, 415);
    const oversized = await fetch(`${base}/placa/reconhecer`, { method: 'POST', body: form(new Blob([new Uint8Array(4 * 1024 * 1024 + 1)])) });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).status, 'image_too_large');
});

test('rotas de integração respeitam autenticação', async t => {
    const base = await serverFor(t, { env: {}, auth: (req, res, next) => req.headers['x-admin-token'] === 'test' ? next() : res.status(401).json({ error: 'Sem acesso' }) });
    assert.equal((await fetch(`${base}/placa/ABC1D23`)).status, 401);
    assert.equal((await fetch(`${base}/servicos/placas`)).status, 401);
    assert.equal((await fetch(`${base}/health`)).status, 200);
});
