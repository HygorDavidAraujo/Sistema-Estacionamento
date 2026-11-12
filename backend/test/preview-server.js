// Ambiente de teste: sem dotenv, banco ou consultas externas.
import express from 'express';
import { resolve } from 'node:path';
import { createPlateRouter } from '../routes/plates.js';

const app = express();
app.use(express.json());
app.use('/frontend', express.static(resolve('../frontend')));
app.get('/', (_req, res) => res.sendFile(resolve('../index.html')));
app.use(createPlateRouter({ env: {}, fetchImpl: async url => Response.json({ brand: 'MARCA TESTE', model: url.includes('DEF4G56') ? 'VEÍCULO B' : 'VEÍCULO A', color: 'Cinza' }) }));
app.get('/configuracoes', (_req, res) => res.json({ success: true, dados: Object.fromEntries(Object.entries({ valor_hora_inicial: '5', valor_hora_adicional: '2.5', tempo_tolerancia: '15', total_vagas: '50' }).map(([key, valor]) => [key, { valor }])) }));
app.get('/patio/ativos', (_req, res) => res.json({ success: true, dados: [] }));
app.get('/dashboard', (_req, res) => res.json({ success: true, dados: { total_vagas: 50, vagas_ocupadas: 0, vagas_disponiveis: 50, percentual_ocupacao: 0 } }));
app.get('/caixa/dashboard', (_req, res) => res.json({ success: true, dados: { total_recebido: 0, total_dinheiro: 0, total_credito: 0, total_debito: 0, total_pix: 0, total_transacoes: 0 } }));
app.get('/caixa/turnos/atual', (_req, res) => res.json({ success: true, dados: null }));
app.get('/mensalistas/:placa', (_req, res) => res.status(404).json({ success: false }));
app.post('/entrada', (_req, res) => res.json({ success: true, entry_id: 'test-entry' }));
app.post('/__shutdown', (_req, res) => {
    res.end('ok');
    setImmediate(() => { server.closeAllConnections(); server.close(); });
});
const server = app.listen(3108, '127.0.0.1', () => console.log('Preview de teste: http://127.0.0.1:3108'));
