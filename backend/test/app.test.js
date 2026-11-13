import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('aplicação completa inicia, serve a interface e protege as rotas sem tocar no banco real', async t => {
    const child = spawn(process.execPath, ['server.js'], {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, PORT: '3109', NODE_ENV: 'test', VERCEL: '', ADMIN_TOKEN: 'integration-test',
            DATABASE_URL: 'postgres://test:test@127.0.0.1:1/test', PGSSLMODE: 'disable', ANPR_API_KEY: '', ANPR_URL: '' },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', () => {});
    t.after(async () => { const exited = once(child, 'exit'); child.kill(); await exited; });
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { clearInterval(interval); reject(Error('Servidor não iniciou')); }, 10000);
        const interval = setInterval(() => {
            if (output.includes('Servidor rodando')) { clearTimeout(timeout); clearInterval(interval); resolve(); }
        }, 50);
    });
    const base = 'http://127.0.0.1:3109';
    assert.equal((await (await fetch(`${base}/health`)).json()).service, 'estacionamento');
    assert.match(await (await fetch(base)).text(), /plate-camera.js/);
    assert.equal((await fetch(`${base}/frontend/js/plate-camera.js`)).status, 200);
    assert.equal((await fetch(`${base}/historico`)).status, 401);
    assert.equal((await fetch(`${base}/api/mensalistas`)).status, 401);
    assert.equal((await fetch(`${base}/api/placa/12345678`, { headers: { 'x-admin-token': 'integration-test' } })).status, 401);
    assert.equal((await fetch(`${base}/backend/.env`)).status, 404);
    assert.equal((await fetch(`${base}/configuracoes`)).status, 401);
    assert.equal((await fetch(`${base}/api/servicos/placas`, { headers: { 'x-admin-token': 'integration-test' } })).status, 401);
});
