import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { AsyncLocalStorage } from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
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
import { createCashRouter } from './routes/cash.js';
import { createSubscriptionsRouter } from './routes/subscriptions.js';
import { createReportsRouter } from './routes/reports.js';
import {createOperationalService} from './services/operational-service.js';
import {createOperationalRouter} from './routes/operational.js';
import {operationLock} from './services/backup-domain.js';
import {workHours,seedPeriodSettings} from './services/period-domain.js';

export function createApp({ db, env = process.env, setupToken = env.AUTH_SETUP_TOKEN || env.ADMIN_TOKEN || '', clock, plateFetch, readinessOptions = {},backupStorage } = {}) {
const { initDb, query, tx:baseTx } = db;
const app = express();
const requestIdentity = new AsyncLocalStorage();
const tx=work=>baseTx(async client=>{
    if(!requestIdentity.getStore())return work(client);
    let guarded=false;
    const guard=async()=>{
        if(guarded)return;guarded=true;
        await client.query('SELECT pg_advisory_xact_lock_shared($1)',[operationLock]);
        const context=requestIdentity.getStore(),readOnly=['GET','HEAD'].includes(context.method)&&!/^\/mensalistas\/\d+\/financeiro\/?$/i.test(context.path);
        if((await client.query('SELECT manutencao FROM operacao_estado WHERE id=1 FOR SHARE')).rows[0]?.manutencao&&!readOnly)throw new OperationError('Operação em manutenção. Aguarde a conferência e liberação do administrador.',503);
    };
    return work({query:async(sql,params)=>{
        if(!guarded&&/^SET TRANSACTION ISOLATION LEVEL /i.test(sql))return client.query(sql,params);
        await guard();return client.query(sql,params);
    }});
});
const operations=createOperationalService({query,tx:baseTx,env,clock,storage:backupStorage});

app.disable('etag'); // Desabilita ETag para evitar 304
app.use((req,res,next)=>{
    req.requestId=randomUUID();res.set('X-Request-ID',req.requestId);const started=Date.now();
    res.once('finish',()=>{if(res.statusCode>=500)console.error('[BACK] Requisição não concluída:',{referencia:req.requestId,metodo:req.method,rota:req.path,status:res.statusCode,duracao_ms:Date.now()-started});});next();
});
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
const operationalRoutes=createOperationalRouter({service:operations,query,tx:baseTx,allow,ready,env,clock});
app.use(operationalRoutes.publicRouter);

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
                WHERE cm.origem IN ('saida','diaria') AND cm.historico_id = h.id
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
app.use((req,_res,next) => requestIdentity.run({...req.user,method:req.method,path:req.path},next));
app.use((req,res,next) => {
    const path = req.path.toLowerCase().replace(/\/+$/, '');
    if (/^\/auditoria(?:\/|$)/.test(path)) return allow('supervisor','administrador')(req,res,next);
    if (/^\/relatorio(?:\/|$)/.test(path) || /^\/caixa\/relatorio(?:\/|$)/.test(path)) return allow('supervisor','financeiro','administrador')(req,res,next);
    if (req.method !== 'GET') {
        if (path === '/configuracoes') return allow('administrador')(req,res,next);
        if (path === '/patio/cancel') return allow('supervisor','administrador')(req,res,next);
        if (/^\/mensalistas(?:\/|$)/.test(path) && path !== '/mensalistas/pagamentos' && !/^\/mensalistas\/\d+\/(cotacao|cobrancas)$/.test(path)) return allow('supervisor','administrador')(req,res,next);
        if (/^\/caixa\/turnos/.test(path)) return allow('operador','financeiro','supervisor','administrador')(req,res,next);
    }
    next();
});
app.use(operationalRoutes.router);

app.use(createCashRouter({query,tx,allow,timeZone:APP_TIMEZONE,clock}));
app.use(createOperationsRouter({ query, tx, allow, timeZone: APP_TIMEZONE, clock }));
app.use(createBackupRouter({ tx:baseTx, allow,operations }));
app.use(createSubscriptionsRouter({query,tx,allow,clock,timeZone:APP_TIMEZONE}));
app.use(createReportsRouter({query,tx,allow,timeZone:APP_TIMEZONE}));

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
                diarista,diaria_retirada_em,diaria_valor_pago,tarifa,
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
                                diarista,diaria_retirada_em,diaria_valor_pago,tarifa,
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
            } else if(['expediente_inicio','expediente_fim'].includes(key)){
                if(typeof value!=='string'||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))fail('Horário de expediente inválido');
            } else if(Object.hasOwn(text,key)){
                if(typeof value!=='string'||value.length>text[key]||key==='nome_estacionamento'&&!value.trim()) fail(`Configuração inválida: ${key}`);
            } else fail(`Configuração desconhecida: ${key}`);
        }
        await tx(async client=>{
            await seedPeriodSettings(client);
            const hours=(await client.query("SELECT chave,valor FROM configuracoes WHERE chave IN ('expediente_inicio','expediente_fim') FOR UPDATE")).rows;
            workHours({...Object.fromEntries(hours.map(row=>[row.chave,row.valor])),...values});
            const before=(await client.query('SELECT chave,valor FROM configuracoes WHERE chave=ANY($1::text[])',[Object.keys(values)])).rows;
            for(const[key,value]of Object.entries(values)) await client.query('UPDATE configuracoes SET valor=$1,atualizado_em=NOW() WHERE chave=$2',[String(value),key]);
            await audit(client,req.user,'configuracoes_update',{antes:before,depois:values});
        });
        res.json({success:true,mensagem:'Configurações salvas'});
    }catch(error){next(error);}
});

app.use((err, _req, res, _next) => {
    if (res.headersSent) return;
    const unavailable=['ETIMEDOUT','ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','08006','57P01','57P03','57014'].includes(err.code);
    const concurrent=['40001','40P01'].includes(err.code);
    const status = err instanceof OperationError ? err.status : unavailable?503:err.status === 413 ? 413 : err.type === 'entity.parse.failed' ? 400 : err.code === '23505'||concurrent ? 409 : 500;
    const message = err instanceof OperationError ? err.message : unavailable?'Banco de dados temporariamente indisponível. Tente novamente.':concurrent?'Os dados mudaram durante a operação. Atualize e confira novamente.':status === 413 ? 'Arquivo maior que o limite de 10 MB' : status === 400 ? 'JSON inválido' : status === 409 ? 'Já existe um registro com estes dados' : 'Não foi possível concluir a operação';
    if(status===503)res.set('Retry-After','2');
    if (status === 500) console.error('[BACK] Falha de operação:', err.code || err.name);
    res.status(status).json({ success: false, error: message,request_id:_req.requestId });
});
return app;
}
