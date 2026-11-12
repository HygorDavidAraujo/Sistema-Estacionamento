import test from 'node:test';
import assert from 'node:assert/strict';
import { createVehicleLookup } from '../services/vehicle-lookup.js';
import { requestJson } from '../services/plate-domain.js';

const payload = { plate: 'ABC1D23', brand: 'CHEVROLET', model: 'TRACKER', color: 'Cinza' };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('consulta gratuita normaliza a placa e retorna os três campos e a cota', async () => {
    let request;
    const service = createVehicleLookup({ env: {}, fetchImpl: async (url, options) => {
        request = { url, options };
        return json(payload, 200, { 'x-plate-quota-limit': '5', 'x-plate-quota-remaining': '4' });
    } });
    const result = await service.lookup('abc-1d23');
    assert.equal(request.url, 'https://fipe.parallelum.com.br/api/v2/plates/ABC1D23');
    assert.equal(request.options.headers['X-Subscription-Token'], undefined);
    assert.deepEqual([result.marca, result.modelo, result.cor], ['CHEVROLET', 'TRACKER', 'Cinza']);
    assert.equal(result.completo, true);
    assert.equal(result.cota.restante, 4);
});

test('consultas simultâneas e repetidas usam uma única chamada e persistem o resultado', async () => {
    let calls = 0;
    let writes = 0;
    const service = createVehicleLookup({ env: {}, repository: { set: async () => writes++ }, fetchImpl: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return json(payload); } });
    const results = await Promise.all([service.lookup('ABC1D23'), service.lookup('ABC1D23')]);
    const cached = await service.lookup('ABC1D23');
    assert.equal(calls, 1);
    assert.equal(writes, 1);
    assert.equal(cached.origem, 'cache');
    assert.equal(results[0].encontrado, true);
});

test('cadastro compartilhado evita chamada externa e continua marcado como encontrado', async () => {
    const service = createVehicleLookup({ repository: { get: async () => ({ marca: 'Marca', modelo: 'Modelo', cor: 'Azul' }) }, fetchImpl: async () => { throw Error('Não deve consultar'); } });
    assert.equal((await service.lookup('ABC1234')).encontrado, true);
    assert.equal((await service.lookup('ABC1234')).origem, 'cache');
});

test('placa inválida é recusada antes do cache e do fornecedor', async () => {
    const service = createVehicleLookup({ repository: { get: () => assert.fail('cache') }, fetchImpl: () => assert.fail('api') });
    await assert.rejects(service.lookup('12345678'), { code: 'invalid_plate', status: 400 });
});

test('cota esgotada é identificada e impede repetição imediata em outras placas', async () => {
    let calls = 0;
    const service = createVehicleLookup({ env: {}, fetchImpl: async () => { calls++; return json({}, 429); } });
    await assert.rejects(service.lookup('ABC1D23'), { code: 'quota_exceeded' });
    await assert.rejects(service.lookup('DEF4G56'), { code: 'quota_exceeded' });
    assert.equal(calls, 1);
    assert.equal(service.status().limitado, true);
});

test('HTML, credencial incorreta e cadastro ausente têm erros distintos', async () => {
    await assert.rejects(requestJson('https://example.test', {}, async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })), { code: 'invalid_response' });
    await assert.rejects(requestJson('https://example.test', {}, async () => json({}, 401)), { code: 'credentials', status: 503 });
    await assert.rejects(requestJson('https://example.test', {}, async () => json({}, 404)), { code: 'not_found', status: 404 });
});

test('timeout cobre o corpo da resposta e aborta a requisição', async () => {
    let aborted = false;
    const fetchImpl = async (_url, options) => ({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: () => new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    }) });
    await assert.rejects(requestJson('https://example.test', {}, fetchImpl, 15), { code: 'timeout' });
    assert.equal(aborted, true);
});

test('resposta de outra placa é rejeitada', async () => {
    const service = createVehicleLookup({ fetchImpl: async () => json({ ...payload, plate: 'DEF4G56' }) });
    await assert.rejects(service.lookup('ABC1D23'), { code: 'invalid_response' });
});

test('dados parciais não inventam marca, modelo ou cor', async () => {
    const service = createVehicleLookup({ env: {}, fetchImpl: async () => json({ brand: 'Marca', model: 'Modelo' }) });
    const result = await service.lookup('ABC1D23');
    assert.equal(result.status, 'partial');
    assert.equal(result.cor, '');
    assert.equal(result.completo, false);
});

test('falha do banco não impede retorno cadastral e token gratuito permanece no servidor', async () => {
    const service = createVehicleLookup({ env: { FIPE_SUBSCRIPTION_TOKEN: 'private-token' },
        repository: { get: async () => { throw Error('offline'); }, set: async () => { throw Error('offline'); } },
        fetchImpl: async (_url, options) => { assert.equal(options.headers['X-Subscription-Token'], 'private-token'); return json(payload); } });
    const result = await service.lookup('ABC1D23');
    assert.equal(result.encontrado, true);
    assert.equal(JSON.stringify(result).includes('private-token'), false);
});
