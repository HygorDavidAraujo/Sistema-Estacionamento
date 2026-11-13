import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { AsyncLocalStorage } from 'node:async_hooks';
import { createPlateRouter } from "./routes/plates.js";
import { createVehicleRepository } from "./services/vehicle-repository.js";
import { isValidPlate } from "./services/plate-domain.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { createAuth } from './services/auth.js';
import { createOperationsRouter } from './routes/operations.js';
import { createBackupRouter } from './routes/backup.js';
import { OperationError, audit, cents, fail } from './services/financial-domain.js';
import { createDatabaseReadiness, initializationFailure } from './services/database-readiness.js';

export function createApp({ db, env = process.env, setupToken = env.AUTH_SETUP_TOKEN || env.ADMIN_TOKEN || '', clock, plateFetch, readinessOptions = {} } = {}) {
const { initDb, query, tx } = db;
const app = express();
const requestIdentity = new AsyncLocalStorage();

app.disable('etag'); // Desabilita ETag para evitar 304
const production = Boolean(env.VERCEL || env.NODE_ENV === 'production');
function trustedOrigin(req, origin) {
    if (!origin) return true;
    const own = `${production ? 'https' : req.protocol}://${req.get('host')}`;
    return origin === own || String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).includes(origin)
        || (!production && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
}
app.use(cors((req, callback) => callback(null, { credentials: true, origin: trustedOrigin(req, req.headers.origin) ? req.headers.origin || false : false })));
app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'DENY');
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && !trustedOrigin(req, req.headers.origin)) return res.status(403).json({ error: 'Origem não autorizada' });
    next();
});
app.use(express.json({ limit: '10mb' }));

// Middleware para forçar no-cache em todas as respostas
app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

app.use((req, _res, next) => {
    if (req.url.startsWith('/api/')) {
        req.url = req.url.replace(/^\/api(?=\/|$)/, '') || '/';
    }
    next();
});
app.use('/frontend', express.static(resolve(__dirname, '../frontend')));
app.get(['/', '/index.html'], (_req, res) => res.sendFile(resolve(__dirname, '../index.html')));
app.use('/backend', (_req,res) => res.sendStatus(404));
function normalizeDateParam(value) {
    if (!value) return null;
    const str = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    const brMatch = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (brMatch) {
        const [, dd, mm, yyyy] = brMatch;
        return `${yyyy}-${mm}-${dd}`;
    }
    return str;
}

const { ready } = createDatabaseReadiness({
    initialize: initDb,
    ...readinessOptions,
    onError: error => console.error('[BACK] Falha ao preparar banco:', initializationFailure(error))
});
async function ensureDatabase() {
    if (!await ready()) throw new OperationError('Banco de dados indisponível. Tente novamente em instantes.', 503);
}
const { router: authRouter, requireAuth, allow } = createAuth({ query, tx, ready, env, setupToken });
app.use('/auth', authRouter);

async function logAudit(acao, detalhes = {}) {
    try {
        await query(
            `INSERT INTO auditoria (acao, detalhes, usuario_id, usuario_nome) VALUES ($1, $2, $3, $4)`,
            [acao, JSON.stringify(detalhes || {}), requestIdentity.getStore()?.id || null, requestIdentity.getStore()?.nome || 'Sistema']
        );
    } catch (err) {
        console.warn('[BACK] Falha ao registrar auditoria:', err.message);
    }
}

const APP_TIMEZONE = env.APP_TIMEZONE || 'America/Sao_Paulo';

function formatDateLocal(date, timeZone = APP_TIMEZONE) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const get = (type) => parts.find(p => p.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
}

function formatTimeLocal(date, timeZone = APP_TIMEZONE) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).formatToParts(date);
    const get = (type) => parts.find(p => p.type === type)?.value || '00';
    return `${get('hour')}:${get('minute')}:${get('second')}`;
}

function sanitizePlate(p) {
    if (!p) return '';
    return String(p).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function normalizePaymentMethod(value) {
    if (!value) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const normalized = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (normalized.includes('pix')) return 'Pix';
    if (normalized.includes('dinheiro') || normalized.includes('cash')) return 'Dinheiro';
    if (normalized.includes('debito')) return 'Cartão de Débito';
    if (normalized.includes('credito')) return 'Cartão de Crédito';
    return raw;
}


async function getCaixaResumoPorData(dataRef) {
    const result = await query(
        `WITH movimentos AS (
            SELECT data_saida AS data_ref, forma_pagamento, valor_pago
            FROM historico h
            WHERE status = 'saído'
                            AND data_saida = $1
              AND NOT EXISTS (
                SELECT 1 FROM caixa_movimentos cm
                WHERE cm.origem = 'saida' AND cm.historico_id = h.id
              )
            UNION ALL
            SELECT data_pagamento AS data_ref, forma_pagamento, valor_pago
            FROM caixa_movimentos
                        WHERE data_pagamento = $1
        )
        SELECT 
            COALESCE(SUM(valor_pago), 0) as total_recebido,
            COALESCE(SUM(CASE WHEN lower(forma_pagamento) LIKE '%dinheiro%' THEN valor_pago ELSE 0 END), 0) as total_dinheiro,
            COALESCE(SUM(CASE WHEN lower(forma_pagamento) LIKE '%credito%' OR lower(forma_pagamento) LIKE '%crédito%' THEN valor_pago ELSE 0 END), 0) as total_credito,
            COALESCE(SUM(CASE WHEN lower(forma_pagamento) LIKE '%debito%' OR lower(forma_pagamento) LIKE '%débito%' THEN valor_pago ELSE 0 END), 0) as total_debito,
            COALESCE(SUM(CASE WHEN lower(forma_pagamento) LIKE '%pix%' THEN valor_pago ELSE 0 END), 0) as total_pix,
            COUNT(CASE WHEN valor_pago > 0 THEN 1 END) as total_transacoes
         FROM movimentos`,
        [dataRef]
    );
    return result.rows?.[0] || {};
}

function addMonthsToISODate(baseDateStr, months) {
    const safeBase = typeof baseDateStr === 'string' ? baseDateStr : '';
    const isValidIso = /^\d{4}-\d{2}-\d{2}$/.test(safeBase);
    let dt;
    if (isValidIso) {
        const [y, m, d] = safeBase.split('-').map(Number);
        dt = new Date(Date.UTC(y, m - 1, d));
    } else {
        const now = new Date();
        dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    }
    dt.setUTCMonth(dt.getUTCMonth() + (Number(months) || 0));
    return dt.toISOString().slice(0, 10);
}

// Consultas e reconhecimento independentes do fluxo financeiro.
app.use(createPlateRouter({
    env, fetchImpl: plateFetch,
    repository: createVehicleRepository(query, ready),
    auth: requireAuth
}));

// Leitura de dados operacionais segue a mesma proteção das alterações.
app.use(requireAuth);
app.use((req,_res,next) => requestIdentity.run(req.user,next));
app.use((req,res,next) => {
    const path = req.path.toLowerCase().replace(/\/+$/, '');
    if (/^\/auditoria(?:\/|$)/.test(path)) return allow('supervisor','administrador')(req,res,next);
    if (/^\/relatorio(?:\/|$)/.test(path) || /^\/caixa\/(dashboard|relatorio|fechamentos)(?:\/|$)/.test(path)) return allow('supervisor','financeiro','administrador')(req,res,next);
    if (req.method !== 'GET') {
        if (path === '/configuracoes') return allow('administrador')(req,res,next);
        if (path === '/patio/cancel' || path === '/caixa/fechamento') return allow('supervisor','administrador')(req,res,next);
        if (/^\/mensalistas(?:\/|$)/.test(path) && path !== '/mensalistas/pagamentos') return allow('supervisor','administrador')(req,res,next);
        if (/^\/caixa\/turnos/.test(path)) return allow('operador','supervisor','administrador')(req,res,next);
    }
    next();
});

app.use(createOperationsRouter({ query, tx, allow, timeZone: APP_TIMEZONE, clock }));
app.use(createBackupRouter({ tx, allow }));

// ROTA PARA LISTAR VEÍCULOS ATIVOS NO PÁTIO
app.get("/patio/ativos", async (req, res) => {
    try {
        await ensureDatabase();
        const result = await query(
            `SELECT
                id,
                entry_id,
                placa,
                marca,
                modelo,
                cor,
                mensalista,
                diarista,
                cliente_nome,
                cliente_telefone,
                cliente_cpf,
                TO_CHAR(criado_em AT TIME ZONE $1, 'YYYY-MM-DD') as data_entrada_iso,
                TO_CHAR(criado_em AT TIME ZONE $1, 'HH24:MI:SS') as hora_entrada_iso,
                (EXTRACT(EPOCH FROM criado_em) * 1000)::bigint as hora_entrada_ms,
                status,
                criado_em
             FROM historico
             WHERE status = 'ativo'
             ORDER BY criado_em DESC`,
            [APP_TIMEZONE]
        );
        res.json({ success: true, dados: result.rows || [] });
    } catch (err) {
        console.error('[BACK] Erro ao listar pátio:', err);
        return res.status(500).json({ error: 'Erro ao listar pátio' });
    }
});

// ROTA PARA OBTER VEÍCULO ATIVO POR entryId/placa
app.get("/patio/ativo", async (req, res) => {
    const { entryId, placa } = req.query;
    const placaNorm = placa ? sanitizePlate(placa) : null;

    if (!entryId && !placaNorm) {
        return res.status(400).json({ error: 'entryId ou placa é obrigatório' });
    }

    try {
        await ensureDatabase();
                const result = await query(
                        `SELECT
                                id,
                                entry_id,
                                placa,
                                marca,
                                modelo,
                                cor,
                                mensalista,
                                diarista,
                                cliente_nome,
                                cliente_telefone,
                                cliente_cpf,
                                TO_CHAR(criado_em AT TIME ZONE $3, 'YYYY-MM-DD') as data_entrada_iso,
                                TO_CHAR(criado_em AT TIME ZONE $3, 'HH24:MI:SS') as hora_entrada_iso,
                                (EXTRACT(EPOCH FROM criado_em) * 1000)::bigint as hora_entrada_ms,
                                status,
                                criado_em
                         FROM historico
                         WHERE status = 'ativo'
                             AND (entry_id = $1 OR placa = $2)
                         ORDER BY criado_em DESC
                         LIMIT 1`,
                        [entryId || '', placaNorm || '', APP_TIMEZONE]
                );
        const row = result.rows?.[0];
        if (!row) {
            return res.status(404).json({ error: 'Entrada ativa não encontrada' });
        }
        res.json({ success: true, dados: row });
    } catch (err) {
        console.error('[BACK] Erro ao buscar entrada ativa:', err);
        return res.status(500).json({ error: 'Erro ao buscar entrada ativa' });
    }
});

// ROTA PARA CANCELAR UMA ENTRADA (SEM COBRANÇA)
app.post('/patio/cancel', async (req,res,next) => {
    try {
        const reason=String(req.body.motivo || '').trim();
        if(reason.length<10 || reason.length>255) fail('Informe motivo de 10 a 255 caracteres');
        if(!req.body.entryId) fail('Informe o ticket exato para cancelar');
        const result=await tx(async client=>{
            const entry=(await client.query("SELECT * FROM historico WHERE entry_id=$1 AND status='ativo' FOR UPDATE",[req.body.entryId])).rows[0];
            if(!entry) fail('Entrada ativa não encontrada',409);
            if((await client.query("SELECT id FROM caixa_movimentos WHERE historico_id=$1",[entry.id])).rows.length) fail('Esta entrada possui pagamento e não pode ser cancelada',409);
            const now=new Date();
            await client.query("UPDATE historico SET status='cancelado',data_saida=$1,hora_saida=$2 WHERE id=$3 AND status='ativo'",[formatDateLocal(now),formatTimeLocal(now),entry.id]);
            await audit(client,req.user,'cancelamento_entrada',{entry_id:entry.entry_id,placa:entry.placa,motivo:reason});
            return entry.entry_id;
        });
        res.json({success:true,entry_id:result});
    }catch(error){next(error);}
});

// ROTA PARA OBTER HISTÓRICO COMPLETO
app.get("/historico", async (req, res) => {
    const { dataInicio, dataFim, dia, mes, ano, tipo } = req.query;
    
    let sql = `
        SELECT
            id,
            entry_id,
            placa,
            marca,
            modelo,
            cor,
            mensalista,
            diarista,
            cliente_nome,
            cliente_telefone,
            cliente_cpf,
            TO_CHAR(data_entrada, 'DD/MM/YYYY') as data_entrada,
            TO_CHAR(hora_entrada, 'HH24:MI:SS') as hora_entrada,
            TO_CHAR(data_saida, 'DD/MM/YYYY') as data_saida,
            TO_CHAR(hora_saida, 'HH24:MI:SS') as hora_saida,
            tempo_permanencia,
            (SELECT chave FROM operacoes_financeiras WHERE tipo='saida' AND referencia=historico.id ORDER BY criado_em DESC LIMIT 1) AS operacao_id,
            valor_pago,
            forma_pagamento,
            status,
            criado_em
        FROM historico
        WHERE 1=1`;
    let params = [];
    const addParam = (value) => {
        params.push(value);
        return `$${params.length}`;
    };
    
    // Filtro por período (data início e fim)
    if (dataInicio && dataFim) {
        sql += ` AND data_entrada BETWEEN ${addParam(dataInicio)} AND ${addParam(dataFim)}`;
    }
    // Filtro por dia, mês e ano
    else if (dia && mes && ano) {
        sql += ` AND EXTRACT(DAY FROM data_entrada) = ${addParam(parseInt(dia, 10))} AND EXTRACT(MONTH FROM data_entrada) = ${addParam(parseInt(mes, 10))} AND EXTRACT(YEAR FROM data_entrada) = ${addParam(parseInt(ano, 10))}`;
    }
    // Filtro por mês e ano
    else if (mes && ano) {
        sql += ` AND EXTRACT(MONTH FROM data_entrada) = ${addParam(parseInt(mes, 10))} AND EXTRACT(YEAR FROM data_entrada) = ${addParam(parseInt(ano, 10))}`;
    }
    // Filtro apenas por ano
    else if (ano) {
        sql += ` AND EXTRACT(YEAR FROM data_entrada) = ${addParam(parseInt(ano, 10))}`;
    }
    // Filtro apenas por dia (todos os meses/anos)
    else if (dia) {
        sql += ` AND EXTRACT(DAY FROM data_entrada) = ${addParam(parseInt(dia, 10))}`;
    }

    if (tipo === 'mensalista') {
        sql += ` AND mensalista = ${addParam(true)}`;
    } else if (tipo === 'diarista') {
        sql += ` AND diarista = ${addParam(true)}`;
    } else if (tipo === 'avulso') {
        sql += ` AND mensalista = false AND diarista = false`;
    }
    
    sql += ` ORDER BY criado_em DESC`;
    
    try {
        await ensureDatabase();
        const result = await query(sql, params);
        res.json({ success: true, dados: result.rows || [] });
    } catch (err) {
        console.error("[BACK] Erro ao buscar histórico:", err);
        return res.status(500).json({ error: "Erro ao buscar histórico" });
    }
});

// ROTA PARA OBTER HISTÓRICO FILTRADO POR PLACA
app.get("/historico/:placa", async (req, res) => {
    const placa = sanitizePlate(req.params.placa);
    try {
        await ensureDatabase();
        const result = await query(
            `SELECT
                id,
                entry_id,
                placa,
                marca,
                modelo,
                cor,
                mensalista,
                diarista,
                cliente_nome,
                cliente_telefone,
                cliente_cpf,
                TO_CHAR(data_entrada, 'DD/MM/YYYY') as data_entrada,
                TO_CHAR(hora_entrada, 'HH24:MI:SS') as hora_entrada,
                TO_CHAR(data_saida, 'DD/MM/YYYY') as data_saida,
                TO_CHAR(hora_saida, 'HH24:MI:SS') as hora_saida,
                tempo_permanencia,
                (SELECT chave FROM operacoes_financeiras WHERE tipo='saida' AND referencia=historico.id ORDER BY criado_em DESC LIMIT 1) AS operacao_id,
                valor_pago,
                forma_pagamento,
                status,
                criado_em
             FROM historico WHERE placa = $1 ORDER BY criado_em DESC`,
            [placa]
        );
        res.json({ success: true, dados: result.rows || [] });
    } catch (err) {
        console.error("[BACK] Erro ao buscar histórico:", err);
        return res.status(500).json({ error: "Erro ao buscar histórico" });
    }
});

// ROTA PARA OBTER RELATÓRIO RESUMIDO (ESTATÍSTICAS)
app.get("/relatorio/resumo", async (req, res) => {
    const { tipo } = req.query;
    try {
        await ensureDatabase();
        let where = '';
        const params = [];
        if (tipo === 'mensalista') {
            where = 'WHERE mensalista = $1';
            params.push(true);
        } else if (tipo === 'diarista') {
            where = 'WHERE diarista = $1';
            params.push(true);
        } else if (tipo === 'avulso') {
            where = 'WHERE mensalista = false AND diarista = false';
        }
        const result = await query(
            `SELECT 
                COUNT(*) as total_movimentacoes,
                COUNT(CASE WHEN status = 'saído' THEN 1 END) as total_saidas,
                COUNT(CASE WHEN status = 'ativo' THEN 1 END) as veiculos_no_patio,
                COALESCE(SUM(valor_pago), 0) as receita_total,
                COALESCE(AVG(valor_pago), 0) as valor_medio,
                COUNT(DISTINCT placa) as total_veiculos_unicos
             FROM historico ${where}`,
            params
        );
        res.json({ success: true, dados: result.rows?.[0] || {} });
    } catch (err) {
        console.error("[BACK] Erro ao gerar relatório:", err);
        return res.status(500).json({ error: "Erro ao gerar relatório" });
    }
});

app.get("/api/relatorio/resumo", async (req, res) => {
    req.url = '/relatorio/resumo';
    return app.handle(req, res);
});

// ROTA PARA OBTER DASHBOARD DE CAIXA
app.get("/caixa/dashboard", async (req, res) => {
    const hoje = formatDateLocal(new Date());

    try {
        await ensureDatabase();
        const dados = await getCaixaResumoPorData(hoje);
        res.json({ success: true, dados });
    } catch (err) {
        console.error("[BACK] Erro ao gerar dashboard de caixa:", err);
        return res.status(500).json({ error: "Erro ao gerar dashboard de caixa" });
    }
});

app.get("/api/caixa/dashboard", async (req, res) => {
    req.url = '/caixa/dashboard';
    return app.handle(req, res);
});

// ROTA PARA RELATÓRIO DE CAIXA POR PERÍODO
app.get("/caixa/relatorio", async (req, res) => {
    const dataInicio = normalizeDateParam(req.query.dataInicio);
    const dataFim = normalizeDateParam(req.query.dataFim);
    
    let sql = `
        WITH movimentos AS (
            SELECT data_saida AS data_ref, forma_pagamento, valor_pago
            FROM historico h
            WHERE status = 'saído'
              AND NOT EXISTS (
                SELECT 1 FROM caixa_movimentos cm
                WHERE cm.origem = 'saida' AND cm.historico_id = h.id
              )
            UNION ALL
            SELECT data_pagamento AS data_ref, forma_pagamento, valor_pago
            FROM caixa_movimentos
        )
        SELECT 
            TO_CHAR(data_ref, 'DD/MM/YYYY') as data_saida,
            forma_pagamento,
            COUNT(*) as quantidade,
            COALESCE(SUM(valor_pago), 0) as total
        FROM movimentos 
        WHERE 1=1
    `;
    
    let params = [];
    
    if (dataInicio && dataFim) {
        sql += ` AND data_ref BETWEEN $1 AND $2`;
        params.push(dataInicio, dataFim);
    } else if (dataInicio) {
        sql += ` AND data_ref >= $1`;
        params.push(dataInicio);
    } else if (dataFim) {
        sql += ` AND data_ref <= $1`;
        params.push(dataFim);
    }
    
    sql += ` GROUP BY data_ref, forma_pagamento ORDER BY data_ref DESC, forma_pagamento`;
    
    try {
        await ensureDatabase();
        const result = await query(sql, params);
        res.json({ success: true, dados: result.rows || [] });
    } catch (err) {
        console.error("[BACK] Erro ao gerar relatório de caixa:", err);
        return res.status(500).json({ error: "Erro ao gerar relatório de caixa" });
    }
});

app.get("/api/caixa/relatorio", async (req, res) => {
    req.url = '/caixa/relatorio';
    return app.handle(req, res);
});
// FECHAMENTO DE CAIXA
app.post("/caixa/fechamento", requireAuth, async (req, res) => {
    const data_ref = normalizeDateParam(req.body?.data_ref) || formatDateLocal(new Date());
    const observacao = String(req.body?.observacao || '').trim() || null;
    const force = req.body?.force === true;
    if (force && observacao?.length < 10 || force && !observacao) return res.status(400).json({ error: 'Informe justificativa de ao menos 10 caracteres' });

    try {
        await ensureDatabase();

        const existente = await query(`SELECT id FROM caixa_fechamentos WHERE data_ref = $1`, [data_ref]);
        if (existente.rows?.[0] && !force) {
            return res.status(409).json({ error: 'Fechamento já existe para esta data' });
        }

        const resumo = await getCaixaResumoPorData(data_ref);
        const payload = {
            total_recebido: Number(resumo.total_recebido || 0),
            total_dinheiro: Number(resumo.total_dinheiro || 0),
            total_credito: Number(resumo.total_credito || 0),
            total_debito: Number(resumo.total_debito || 0),
            total_pix: Number(resumo.total_pix || 0),
            total_transacoes: Number(resumo.total_transacoes || 0)
        };

        if (existente.rows?.[0]) {
            await query(`UPDATE caixa_fechamentos
                 SET total_recebido = $1, total_dinheiro = $2, total_credito = $3, total_debito = $4, total_pix = $5, total_transacoes = $6, observacao = $7
                 WHERE data_ref = $8`,
                [payload.total_recebido, payload.total_dinheiro, payload.total_credito, payload.total_debito, payload.total_pix, payload.total_transacoes, observacao, data_ref]
            );
        } else {
            await query(`INSERT INTO caixa_fechamentos (data_ref, total_recebido, total_dinheiro, total_credito, total_debito, total_pix, total_transacoes, observacao)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [data_ref, payload.total_recebido, payload.total_dinheiro, payload.total_credito, payload.total_debito, payload.total_pix, payload.total_transacoes, observacao]
            );
        }

        await logAudit('caixa_fechamento', { data_ref, ...payload, force });

        return res.json({ success: true, dados: { data_ref, observacao, ...payload } });
    } catch (err) {
        console.error('[BACK] Erro ao fechar caixa:', err);
        return res.status(500).json({ error: 'Erro ao fechar caixa' });
    }
});

app.get("/caixa/fechamentos", requireAuth, async (req, res) => {
    const dataInicio = normalizeDateParam(req.query.dataInicio);
    const dataFim = normalizeDateParam(req.query.dataFim);

    let sql = `SELECT
        id,
        TO_CHAR(data_ref, 'YYYY-MM-DD') as data_ref,
        total_recebido,
        total_dinheiro,
        total_credito,
        total_debito,
        total_pix,
        total_transacoes,
        observacao,
        criado_em
     FROM caixa_fechamentos WHERE 1=1`;
    const params = [];

    if (dataInicio) {
        params.push(dataInicio);
        sql += ` AND data_ref >= $${params.length}`;
    }
    if (dataFim) {
        params.push(dataFim);
        sql += ` AND data_ref <= $${params.length}`;
    }

    sql += ` ORDER BY data_ref DESC`;

    try {
        await ensureDatabase();
        const result = await query(sql, params);
        res.json({ success: true, dados: result.rows || [] });
    } catch (err) {
        console.error('[BACK] Erro ao listar fechamentos:', err);
        return res.status(500).json({ error: 'Erro ao listar fechamentos' });
    }
});

// TURNOS DE CAIXA
app.get("/caixa/turnos/atual", requireAuth, async (req, res) => {
    try {
        await ensureDatabase();
        const result = await query(
            `SELECT
                id,
                TO_CHAR(data_ref, 'YYYY-MM-DD') as data_ref,
                aberto_em,
                fechado_em,
                observacao_abertura,
                observacao_fechamento
             FROM caixa_turnos
             WHERE fechado_em IS NULL
             ORDER BY aberto_em DESC
             LIMIT 1`
        );
        return res.json({ success: true, dados: result.rows?.[0] || null });
    } catch (err) {
        console.error('[BACK] Erro ao buscar turno atual:', err);
        return res.status(500).json({ error: 'Erro ao buscar turno atual' });
    }
});

app.post("/caixa/turnos/abrir", requireAuth, async (req, res) => {
    const observacao = String(req.body?.observacao || '').trim() || null;
    const data_ref = normalizeDateParam(req.body?.data_ref) || formatDateLocal(new Date());

    try {
        await ensureDatabase();
        const aberto = await query(
            `SELECT id FROM caixa_turnos WHERE fechado_em IS NULL ORDER BY aberto_em DESC LIMIT 1`
        );
        if (aberto.rows?.[0]) {
            return res.status(409).json({ error: 'Já existe um turno aberto' });
        }

        const insert = await query(
            `INSERT INTO caixa_turnos (data_ref, aberto_em, observacao_abertura)
             VALUES ($1, NOW(), $2)
             RETURNING id, TO_CHAR(data_ref, 'YYYY-MM-DD') as data_ref, aberto_em, observacao_abertura`,
            [data_ref, observacao]
        );

        await logAudit('caixa_turno_abertura', { id: insert.rows?.[0]?.id, data_ref, observacao });

        return res.json({ success: true, dados: insert.rows?.[0] || null });
    } catch (err) {
        console.error('[BACK] Erro ao abrir turno:', err);
        return res.status(500).json({ error: 'Erro ao abrir turno' });
    }
});

app.post("/caixa/turnos/fechar", requireAuth, async (req, res) => {
    const observacao = String(req.body?.observacao || '').trim() || null;
    const turnoId = req.body?.turno_id ? Number(req.body.turno_id) : null;

    try {
        await ensureDatabase();
        let turno;
        if (turnoId) {
            const result = await query(
                `SELECT id, data_ref, aberto_em, fechado_em FROM caixa_turnos WHERE id = $1`,
                [turnoId]
            );
            turno = result.rows?.[0];
        } else {
            const result = await query(
                `SELECT id, data_ref, aberto_em, fechado_em FROM caixa_turnos WHERE fechado_em IS NULL ORDER BY aberto_em DESC LIMIT 1`
            );
            turno = result.rows?.[0];
        }

        if (!turno) {
            return res.status(409).json({ error: 'Nenhum turno aberto para fechar' });
        }
        if (turno.fechado_em) {
            return res.status(409).json({ error: 'Turno já está fechado' });
        }

        await query(
            `UPDATE caixa_turnos SET fechado_em = NOW(), observacao_fechamento = $1 WHERE id = $2`,
            [observacao, turno.id]
        );

        const updated = await query(
            `SELECT
                id,
                TO_CHAR(data_ref, 'YYYY-MM-DD') as data_ref,
                aberto_em,
                fechado_em,
                observacao_abertura,
                observacao_fechamento
             FROM caixa_turnos WHERE id = $1`,
            [turno.id]
        );

        await logAudit('caixa_turno_fechamento', { id: turno.id, observacao });

        return res.json({ success: true, dados: updated.rows?.[0] || null });
    } catch (err) {
        console.error('[BACK] Erro ao fechar turno:', err);
        return res.status(500).json({ error: 'Erro ao fechar turno' });
    }
});

app.get("/caixa/turnos", requireAuth, async (req, res) => {
    const dataInicio = normalizeDateParam(req.query.dataInicio);
    const dataFim = normalizeDateParam(req.query.dataFim);

    let sql = `SELECT
        id,
        TO_CHAR(data_ref, 'YYYY-MM-DD') as data_ref,
        aberto_em,
        fechado_em,
        observacao_abertura,
        observacao_fechamento
     FROM caixa_turnos WHERE 1=1`;
    const params = [];

    if (dataInicio) {
        params.push(dataInicio);
        sql += ` AND data_ref >= $${params.length}`;
    }
    if (dataFim) {
        params.push(dataFim);
        sql += ` AND data_ref <= $${params.length}`;
    }

    sql += ` ORDER BY aberto_em DESC`;

    try {
        await ensureDatabase();
        const result = await query(sql, params);
        return res.json({ success: true, dados: result.rows || [] });
    } catch (err) {
        console.error('[BACK] Erro ao listar turnos:', err);
        return res.status(500).json({ error: 'Erro ao listar turnos' });
    }
});


// ROTA PARA OBTER DASHBOARD DE VAGAS
app.get("/dashboard", async (req, res) => {
    try {
        await ensureDatabase();
        // Busca o total de vagas configurado
        const configResult = await query(
            `SELECT valor FROM configuracoes WHERE chave = $1`,
            ['total_vagas']
        );
        const totalVagas = parseInt(configResult.rows?.[0]?.valor || 0, 10);

        // Conta veículos ativos no pátio
        const ocupadasResult = await query(
            `SELECT COUNT(*)::int as ocupadas FROM historico WHERE status = 'ativo'`,
            []
        );
        const ocupadas = ocupadasResult.rows?.[0]?.ocupadas || 0;
        const disponiveis = totalVagas - ocupadas;

        res.json({ 
            success: true, 
            dados: {
                total_vagas: totalVagas,
                vagas_ocupadas: ocupadas,
                vagas_disponiveis: disponiveis,
                percentual_ocupacao: totalVagas > 0 ? ((ocupadas / totalVagas) * 100).toFixed(1) : 0
            }
        });
    } catch (err) {
        console.error("[BACK] Erro ao buscar total de vagas:", err);
        return res.status(500).json({ error: "Erro ao buscar configuração de vagas" });
    }
});

// ROTA PARA OBTER TODAS AS CONFIGURAÇÕES
app.get("/configuracoes", async (req, res) => {
    try {
        await ensureDatabase();
        const result = await query(
            `SELECT * FROM configuracoes ORDER BY chave`,
            []
        );
        
        // Converte array em objeto para facilitar o uso no frontend
        const configs = {};
        result.rows.forEach(row => {
            configs[row.chave] = {
                valor: row.valor,
                descricao: row.descricao,
                atualizado_em: row.atualizado_em
            };
        });
        
        res.json({ success: true, dados: configs });
    } catch (err) {
        console.error("[BACK] Erro ao buscar configurações:", err);
        return res.status(500).json({ error: "Erro ao buscar configurações" });
    }
});

// ROTA PARA OBTER UMA CONFIGURAÇÃO ESPECÍFICA
app.get("/configuracoes/:chave", async (req, res) => {
    const { chave } = req.params;

    try {
        await ensureDatabase();
        const result = await query(
            `SELECT * FROM configuracoes WHERE chave = $1`,
            [chave]
        );
        const row = result.rows?.[0];
        if (!row) {
            return res.status(404).json({ error: "Configuração não encontrada" });
        }
        res.json({ success: true, dados: row });
    } catch (err) {
        console.error("[BACK] Erro ao buscar configuração:", err);
        return res.status(500).json({ error: "Erro ao buscar configuração" });

    }
});

// ROTA PARA ATUALIZAR CONFIGURAÇÕES
app.put('/configuracoes',async(req,res,next)=>{
    try {
        const values=req.body;
        if(!values || Array.isArray(values) || typeof values!=='object' || !Object.keys(values).length) fail('Configurações inválidas');
        const money=['valor_hora_inicial','valor_hora_adicional','valor_diaria','valor_mensalidade'];
        const text={nome_estacionamento:120,documento_estacionamento:40,endereco_estacionamento:180,telefone_estacionamento:40};
        for(const [key,value] of Object.entries(values)){
            if(money.includes(key)){
                if(cents(value)<=0) fail('Tarifas devem ser maiores que zero');
            } else if(key==='total_vagas' || key==='tempo_tolerancia'){
                const number=Number(value); const min=key==='total_vagas'?1:0; const max=key==='total_vagas'?100000:120;
                if(!Number.isInteger(number)||number<min||number>max) fail(`Configuração inválida: ${key}`);
            } else if(Object.hasOwn(text,key)){
                if(typeof value!=='string'||value.length>text[key]||key==='nome_estacionamento'&&!value.trim()) fail(`Configuração inválida: ${key}`);
            } else fail(`Configuração desconhecida: ${key}`);
        }
        await tx(async client=>{
            const before=(await client.query('SELECT chave,valor FROM configuracoes WHERE chave=ANY($1::text[])',[Object.keys(values)])).rows;
            for(const[key,value]of Object.entries(values)) await client.query('UPDATE configuracoes SET valor=$1,atualizado_em=NOW() WHERE chave=$2',[String(value),key]);
            await audit(client,req.user,'configuracoes_update',{antes:before,depois:values});
        });
        res.json({success:true,mensagem:'Configurações salvas'});
    }catch(error){next(error);}
});

// ROTAS DE MENSALISTAS
app.get("/mensalistas", async (req, res) => {
    const { q, status } = req.query;
    let queryText = `SELECT * FROM mensalistas WHERE 1=1`;
    const params = [];
    const addParam = (val) => {
        params.push(val);
        return `$${params.length}`;
    };

    if (status === 'ativo') {
        queryText += ` AND ativo = ${addParam(true)}`;
    } else if (status === 'inativo') {
        queryText += ` AND ativo = ${addParam(false)}`;
    }

    if (q) {
        const like = `%${q}%`;
        queryText += ` AND (placa ILIKE ${addParam(like)} OR nome ILIKE ${addParam(like)} OR cpf ILIKE ${addParam(like)})`;
    }

    queryText += ` ORDER BY atualizado_em DESC`;

    try {
        await ensureDatabase();
        const result = await query(queryText, params);
        res.json({ success: true, dados: result.rows || [] });
    } catch (err) {
        console.error('[BACK] Erro ao listar mensalistas:', err);
        return res.status(500).json({ error: 'Erro ao listar mensalistas' });
    }
});

app.get("/mensalistas/:placa", async (req, res) => {
    const placa = sanitizePlate(req.params.placa);
    try {
        await ensureDatabase();
        const result = await query(`SELECT * FROM mensalistas WHERE placa = $1`, [placa]);
        const row = result.rows?.[0];
        if (!row) return res.status(404).json({ error: 'Mensalista não encontrado' });
        res.json({ success: true, dados: row });
    } catch (err) {
        console.error('[BACK] Erro ao buscar mensalista:', err);
        return res.status(500).json({ error: 'Erro ao buscar mensalista' });
    }
});

app.post("/mensalistas", requireAuth, async (req, res) => {
    const { placa, nome, telefone, cpf, vencimento, ativo } = req.body || {};
    const placaNorm = sanitizePlate(placa);
    if (!isValidPlate(placaNorm) || typeof nome !== 'string' || !nome.trim() || nome.length > 120 || typeof cpf === 'string' && cpf.length > 20 || typeof telefone === 'string' && telefone.length > 40 || typeof ativo !== 'undefined' && typeof ativo !== 'boolean') return res.status(400).json({ error: 'Confira placa, nome, telefone, CPF e status' });

    try {
        await ensureDatabase();
        const result = await query(
            `INSERT INTO mensalistas (placa, nome, telefone, cpf, vencimento, ativo)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (placa) DO UPDATE SET
                nome = EXCLUDED.nome,
                telefone = EXCLUDED.telefone,
                cpf = EXCLUDED.cpf,
                vencimento = EXCLUDED.vencimento,
                ativo = EXCLUDED.ativo,
                atualizado_em = NOW()
             RETURNING *`,
            [placaNorm, nome, telefone || null, cpf || null, vencimento || null, ativo !== false]
        );
        await logAudit('mensalista_upsert', { placa: placaNorm, nome });
        res.json({ success: true, dados: result.rows?.[0] });
    } catch (err) {
        console.error('[BACK] Erro ao salvar mensalista:', err);
        return res.status(500).json({ error: 'Erro ao salvar mensalista' });
    }
});

app.put("/mensalistas/:id", requireAuth, async (req, res) => {
    const { id } = req.params;
    const { nome, telefone, cpf, vencimento, ativo } = req.body || {};
    if (!nome) return res.status(400).json({ error: 'Nome é obrigatório' });

    try {
        await ensureDatabase();
        const result = await query(
            `UPDATE mensalistas
             SET nome = $1,
                 telefone = $2,
                 cpf = $3,
                 vencimento = $4,
                 ativo = $5,
                 atualizado_em = NOW()
             WHERE id = $6
             RETURNING *`,
            [nome, telefone || null, cpf || null, vencimento || null, ativo !== false, id]
        );
        if (!result.rows?.[0]) return res.status(404).json({ error: 'Mensalista não encontrado' });
        await logAudit('mensalista_update', { id, nome });
        res.json({ success: true, dados: result.rows?.[0] });
    } catch (err) {
        console.error('[BACK] Erro ao atualizar mensalista:', err);
        return res.status(500).json({ error: 'Erro ao atualizar mensalista' });
    }
});

app.patch("/mensalistas/:id/status", requireAuth, async (req, res) => {
    const { id } = req.params;
    const { ativo } = req.body || {};
    try {
        await ensureDatabase();
        const result = await query(
            `UPDATE mensalistas SET ativo = $1, atualizado_em = NOW() WHERE id = $2 RETURNING *`,
            [Boolean(ativo), id]
        );
        if (!result.rows?.[0]) return res.status(404).json({ error: 'Mensalista não encontrado' });
        await logAudit('mensalista_status', { id, ativo: Boolean(ativo) });
        res.json({ success: true, dados: result.rows?.[0] });
    } catch (err) {
        console.error('[BACK] Erro ao atualizar status do mensalista:', err);
        return res.status(500).json({ error: 'Erro ao atualizar status do mensalista' });
    }
});

// HISTÓRICO DE PAGAMENTOS DE MENSALIDADE
app.get("/mensalistas/:id/pagamentos", requireAuth, async (req, res) => {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
    try {
        await ensureDatabase();
        const result = await query(
            `SELECT
                id,
                mensalista_id,
                operacao_chave,
                placa,
                nome,
                valor_pago,
                forma_pagamento,
                TO_CHAR(data_pagamento, 'DD/MM/YYYY') as data_pagamento,
                TO_CHAR(hora_pagamento, 'HH24:MI:SS') as hora_pagamento,
                observacao,
                criado_em
             FROM caixa_movimentos
             WHERE origem = 'mensalidade' AND mensalista_id = $1
             ORDER BY data_pagamento DESC, hora_pagamento DESC, id DESC
             LIMIT $2`,
            [id, limit]
        );
        res.json({ success: true, dados: result.rows || [] });
    } catch (err) {
        console.error('[BACK] Erro ao listar pagamentos de mensalidade:', err);
        return res.status(500).json({ error: 'Erro ao listar pagamentos de mensalidade' });
    }
});

// AUDITORIA
app.get("/auditoria", requireAuth, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
    try {
        await ensureDatabase();
        const result = await query(
            `SELECT id, acao, detalhes, criado_em FROM auditoria ORDER BY criado_em DESC LIMIT $1`,
            [limit]
        );
        res.json({ success: true, dados: result.rows || [] });
    } catch (err) {
        console.error('[BACK] Erro ao listar auditoria:', err);
        return res.status(500).json({ error: 'Erro ao listar auditoria' });
    }
});

app.use((err, _req, res, _next) => {
    if (res.headersSent) return;
    const status = err instanceof OperationError ? err.status : err.status === 413 ? 413 : err.type === 'entity.parse.failed' ? 400 : err.code === '23505' ? 409 : 500;
    const message = err instanceof OperationError ? err.message : status === 413 ? 'Arquivo maior que o limite de 10 MB' : status === 400 ? 'JSON inválido' : status === 409 ? 'Já existe um registro com estes dados' : 'Não foi possível concluir a operação';
    if (status === 500) console.error('[BACK] Falha de operação:', err.code || err.name);
    res.status(status).json({ success: false, error: message });
});
return app;
}
