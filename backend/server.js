import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { initDb, query, tx } from "./db.js";
import multer from "multer";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, _res, next) => {
    if (req.url.startsWith('/api/')) {
        req.url = req.url.replace(/^\/api(?=\/|$)/, '') || '/';
    }
    next();
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });
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

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function requireAuth(req, res, next) {
    if (!ADMIN_TOKEN) return next();
    const token = req.headers['x-admin-token'] || req.headers['X-Admin-Token'];
    if (!token || token !== ADMIN_TOKEN) {
        return res.status(401).json({ error: 'Acesso não autorizado' });
    }
    return next();
}

async function logAudit(acao, detalhes = {}) {
    try {
        await query(
            `INSERT INTO auditoria (acao, detalhes) VALUES ($1, $2)`,
            [acao, JSON.stringify(detalhes || {})]
        );
    } catch (err) {
        console.warn('[BACK] Falha ao registrar auditoria:', err.message);
    }
}

const dbReady = initDb().catch((err) => {
    console.error("[BACK] Falha ao inicializar schema:", err);
});

// API gratuita (sem credencial) para consulta de placa
// Fonte: apicarros.com - retorna marca, modelo, cor, etc.
const FREE_API = 'https://apicarros.com/v1/consulta';

const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/Sao_Paulo';

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

function addMonthsToISODate(baseDateStr, months) {
    const safeBase = typeof baseDateStr === 'string' ? baseDateStr : '';
    const parts = safeBase.split('-').map(Number);
    const y = parts[0];
    const m = parts[1];
    const d = parts[2];
    let dt = new Date(Date.UTC(y || 0, (m || 1) - 1, d || 1));
    if (Number.isNaN(dt.getTime())) {
        const now = new Date();
        dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    }
    dt.setUTCMonth(dt.getUTCMonth() + (Number(months) || 0));
    return dt.toISOString().slice(0, 10);
}

async function getLastVehicleData(placa) {
    try {
        const result = await query(
            `SELECT marca, modelo, cor FROM historico WHERE placa = $1 ORDER BY criado_em DESC LIMIT 1`,
            [placa]
        );
        return result.rows?.[0] || null;
    } catch (err) {
        console.error('[BACK] Erro ao buscar cache de placa:', err);
        return null;
    }
}

// ROTA PARA CONSULTAR A PLACA (API gratuita)
app.get("/placa/:placa", async (req, res) => {
    const placa = sanitizePlate(req.params.placa);
    console.log("[BACK] Consultando placa:", placa);

    if (placa.length < 7) {
        return res.status(400).json({ error: "Placa inválida", encontrado: false });
    }

    await dbReady;
    const cache = await getLastVehicleData(placa);
    const respondWithCache = (mensagem) => res.json({
        encontrado: false,
        marca: cache?.marca || "",
        modelo: cache?.modelo || "",
        cor: cache?.cor || "",
        origem: cache ? 'cache' : 'api',
        mensagem: mensagem || "API indisponível. Preencha manualmente."
    });

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4500);

        const url = `${FREE_API}/${encodeURIComponent(placa)}.json`;
        console.log('[BACK] URL Dados:', url);

        const resp = await fetch(url, { 
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (!resp.ok) {
            console.warn('[BACK] API retornou status:', resp.status);
            return respondWithCache("API indisponível. Preencha manualmente.");
        }

        const data = await resp.json();

        // Alguns retornos podem indicar erro na própria resposta
        if (data?.codigoRetorno && data.codigoRetorno !== "0") {
            console.warn('[BACK] API retornou código de erro:', data.codigoRetorno);
            return respondWithCache("Placa não encontrada. Preencha manualmente.");
        }

        const marca = data?.marca || "";
        const modelo = data?.modelo || "";
        const cor = data?.cor || "";

        if (!marca && !modelo) {
            return respondWithCache("Dados não encontrados. Preencha manualmente.");
        }

        return res.json({
            encontrado: true,
            marca,
            modelo,
            cor,
            origem: 'api'
        });

    } catch (error) {
        console.error("[BACK] ERRO AO CONSULTAR:", error);
        return respondWithCache("Erro na API. Preencha manualmente.");
    }
});

// ROTA PARA RECONHECER PLACA VIA IMAGEM (mock com suporte a provider externo)
app.post("/placa/reconhecer", upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Imagem é obrigatória' });
    }

    // Permite envio de pista manual para testes/ambiente offline
    if (req.body?.hint) {
        const hint = sanitizePlate(req.body.hint);
        if (hint) return res.json({ placa: hint, origem: 'hint' });
    }

    const providerUrl = process.env.ANPR_URL;
    const providerKey = process.env.ANPR_API_KEY;

    const fakePlate = sanitizePlate(process.env.ANPR_FAKE_PLATE || '');

    if (!providerUrl) {
        if (fakePlate) {
            return res.json({ placa: fakePlate, origem: 'fake-env' });
        }
        return res.json({ placa: null, mensagem: 'Serviço de OCR não configurado no backend (defina ANPR_URL ou ANPR_FAKE_PLATE).' });
    }

    if (typeof FormData === 'undefined' || typeof Blob === 'undefined') {
        return res.json({ placa: null, mensagem: 'Runtime sem suporte a FormData/Blob para ANPR. Use Node 18+ ou configure provider diferente.' });
    }

    try {
        const form = new FormData();
        form.append('image', new Blob([req.file.buffer]), req.file.originalname || 'captura.jpg');
        if (providerKey) form.append('api_key', providerKey);

        const resp = await fetch(providerUrl, {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(8000)
        });

        if (!resp.ok) {
            console.warn('[BACK] Provider ANPR falhou:', resp.status);
            if (fakePlate) return res.json({ placa: fakePlate, origem: 'fake-env' });
            return res.json({ placa: null, mensagem: 'Provider ANPR indisponível.' });
        }

        const data = await resp.json().catch(() => ({}));
        const placa = sanitizePlate(data?.placa || data?.plate || data?.results?.[0]?.plate);
        if (placa) return res.json({ placa, origem: 'provider' });

        if (fakePlate) return res.json({ placa: fakePlate, origem: 'fake-env' });
        return res.json({ placa: null, mensagem: 'Placa não reconhecida.' });
    } catch (err) {
        console.error('[BACK] Erro no reconhecimento de placa:', err);
        if (fakePlate) return res.json({ placa: fakePlate, origem: 'fake-env' });
        return res.json({ placa: null, mensagem: 'Erro ao processar a imagem.' });
    }
});

// ROTA PARA REGISTRAR ENTRADA DE VEÍCULO
app.post("/entrada", requireAuth, async (req, res) => {
    let { placa, marca, modelo, cor, entryId } = req.body;
    const mensalista = Boolean(req.body.mensalista);
    const diarista = Boolean(req.body.diarista);
    const cliente_nome = String(req.body.cliente_nome || '').trim();
    const cliente_telefone = String(req.body.cliente_telefone || '').trim();
    const cliente_cpf = String(req.body.cliente_cpf || '').trim();
    
    if (!placa) {
        return res.status(400).json({ error: "Placa é obrigatória" });
    }

    if (mensalista && diarista) {
        return res.status(400).json({ error: "Selecione apenas Mensalista ou Diária" });
    }

    if (mensalista && (!cliente_nome || !cliente_telefone || !cliente_cpf)) {
        return res.status(400).json({ error: "Nome, telefone e CPF são obrigatórios para mensalista" });
    }
    
    // Normaliza placa para maiúsculas
    placa = sanitizePlate(placa);
    const entry_id = entryId || `ent-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    try {
        await dbReady;

        // Verifica capacidade disponível
        const configResult = await query(
            `SELECT valor FROM configuracoes WHERE chave = $1`,
            ['total_vagas']
        );
        const totalVagas = parseInt(configResult.rows?.[0]?.valor || 0, 10);

        const ocupadasResult = await query(
            `SELECT COUNT(*)::int as ocupadas FROM historico WHERE status = 'ativo'`,
            []
        );
        const ocupadas = ocupadasResult.rows?.[0]?.ocupadas || 0;

        if (ocupadas >= totalVagas) {
            return res.status(400).json({ 
                error: "Estacionamento lotado",
                mensagem: `Capacidade máxima atingida (${totalVagas} vagas)`
            });
        }

        // Procede com a entrada
        const now = new Date();
        const data_entrada = formatDateLocal(now);
        const hora_entrada = formatTimeLocal(now);

        const insertResult = await query(
            `INSERT INTO historico (entry_id, placa, marca, modelo, cor, data_entrada, hora_entrada, status, mensalista, diarista, cliente_nome, cliente_telefone, cliente_cpf)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'ativo', $8, $9, $10, $11, $12)
             RETURNING id`,
            [entry_id, placa, marca || '', modelo || '', cor || '', data_entrada, hora_entrada, mensalista, diarista, cliente_nome, cliente_telefone, cliente_cpf]
        );

        if (mensalista && placa) {
            await query(
                `INSERT INTO mensalistas (placa, nome, telefone, cpf)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (placa) DO UPDATE SET
                    nome = EXCLUDED.nome,
                    telefone = EXCLUDED.telefone,
                    cpf = EXCLUDED.cpf,
                    atualizado_em = NOW()`,
                [placa, cliente_nome, cliente_telefone || null, cliente_cpf || null]
            );
        }

        await logAudit('entrada', { placa, entry_id, mensalista, diarista });

        res.json({ 
            success: true, 
            id: insertResult.rows?.[0]?.id,
            entry_id,
            mensagem: "Entrada registrada com sucesso"
        });
    } catch (err) {
        if (err?.code === '23505') {
            return res.status(409).json({ error: 'ID de entrada já existe' });
        }
        console.error("[BACK] Erro ao registrar entrada:", err);
        return res.status(500).json({ error: "Erro ao registrar entrada" });
    }
});

// ROTA PARA REGISTRAR SAÍDA DE VEÍCULO
app.post("/saida", requireAuth, async (req, res) => {
    let { placa, valor_pago, tempo_permanencia, forma_pagamento, entryId, pagamentos } = req.body;
    
    if (!placa && !entryId) {
        return res.status(400).json({ error: "Placa ou entryId é obrigatório" });
    }
    
    const pagamentosList = Array.isArray(pagamentos) ? pagamentos : [];
    const pagamentosNormalizados = pagamentosList
        .map((p) => ({
            forma_pagamento: normalizePaymentMethod(p?.forma_pagamento),
            valor_pago: Number(p?.valor_pago || 0)
        }))
        .filter((p) => p.forma_pagamento && p.valor_pago > 0);

    if (!forma_pagamento && pagamentosNormalizados.length === 0 && Number(valor_pago) > 0) {
        return res.status(400).json({ error: "Forma de pagamento é obrigatória quando há valor a pagar" });
    }
    
    const placaNorm = placa ? sanitizePlate(placa) : null;
    const entry_id = entryId || null;

    const totalPagamentos = pagamentosNormalizados.reduce((acc, cur) => acc + cur.valor_pago, 0);
    if (pagamentosNormalizados.length > 0) {
        valor_pago = totalPagamentos;
        forma_pagamento = pagamentosNormalizados.length === 1 ? pagamentosNormalizados[0].forma_pagamento : 'Múltiplo';
    } else {
        forma_pagamento = normalizePaymentMethod(forma_pagamento);
    }

    const now = new Date();
    const data_saida = formatDateLocal(now);
    const hora_saida = formatTimeLocal(now);
    
    console.log(`[BACK] Registrando saída - entryId: ${entry_id || '-'} Placa: ${placaNorm || '-'}, Valor: ${valor_pago}, Tempo: ${tempo_permanencia}, Forma: ${forma_pagamento}`);

    const paramsBase = [data_saida, hora_saida, valor_pago || 0, tempo_permanencia || '', forma_pagamento || null];

    const tryUpdate = async (whereClause, whereValue) => {
        const result = await query(
            `UPDATE historico 
             SET data_saida = $1, hora_saida = $2, valor_pago = $3, tempo_permanencia = $4, forma_pagamento = $5, status = 'saído'
             WHERE status = 'ativo' AND ${whereClause}
             RETURNING id`,
            [...paramsBase, whereValue]
        );
        return result.rows?.[0]?.id || 0;
    };

        const finalize = async (targetPlaca, historicoId) => {
            if (pagamentosNormalizados.length > 0) {
                for (const p of pagamentosNormalizados) {
                    await query(
                        `INSERT INTO caixa_movimentos (origem, historico_id, placa, valor_pago, forma_pagamento, data_pagamento, hora_pagamento, observacao)
                         VALUES ('saida', $1, $2, $3, $4, $5, $6, $7)`,
                        [
                            historicoId,
                            targetPlaca || placaNorm,
                            p.valor_pago,
                            p.forma_pagamento,
                            data_saida,
                            hora_saida,
                            tempo_permanencia ? `Permanência ${tempo_permanencia}` : null
                        ]
                    );
                }
            }

            await logAudit('saida', {
                placa: targetPlaca || placaNorm,
                entry_id,
                valor_pago: valor_pago || 0,
                forma_pagamento: forma_pagamento || null,
                pagamentos: pagamentosNormalizados
            });
        return res.json({ 
            success: true,
            mensagem: "Saída registrada com sucesso",
            placa: targetPlaca || placaNorm,
            entry_id: entry_id,
            data_saida: data_saida,
            hora_saida: hora_saida,
            valor_pago: valor_pago
        });
    };

    try {
        await dbReady;

        if (entry_id) {
            const updatedId = await tryUpdate('entry_id = $6', entry_id);
            if (!updatedId && placaNorm) {
                // Fallback pela placa se entryId não encontrar
                const updatedId2 = await tryUpdate('placa = $6', placaNorm);
                if (!updatedId2) {
                    console.warn(`[BACK] Veículo não encontrado (entryId/placa): ${entry_id}/${placaNorm}`);
                    return res.status(404).json({ error: "Veículo não encontrado ou já saiu" });
                }
                    return await finalize(placaNorm, updatedId2);
            }

            if (!updatedId) {
                console.warn(`[BACK] Veículo não encontrado para entryId: ${entry_id}`);
                return res.status(404).json({ error: "Veículo não encontrado ou já saiu" });
            }
                return await finalize(placaNorm, updatedId);
        }

        const updatedId = await tryUpdate('placa = $6', placaNorm);
        if (!updatedId) {
            console.warn(`[BACK] Veículo não encontrado: ${placaNorm}`);
            return res.status(404).json({ error: "Veículo não encontrado ou já saiu" });
        }
            return await finalize(placaNorm, updatedId);
    } catch (err) {
        console.error("[BACK] Erro ao registrar saída:", err);
        return res.status(500).json({ error: "Erro ao registrar saída" });
    }
});

// ROTA PARA LISTAR VEÍCULOS ATIVOS NO PÁTIO
app.get("/patio/ativos", async (req, res) => {
    try {
        await dbReady;
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
        await dbReady;
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
        await dbReady;
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
        await dbReady;
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

// ROTA PARA OBTER DASHBOARD DE CAIXA
app.get("/caixa/dashboard", async (req, res) => {
    const hoje = formatDateLocal(new Date());

    try {
        await dbReady;
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
            [hoje]
        );
        res.json({ success: true, dados: result.rows?.[0] || {} });
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
        await dbReady;
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

// ROTA PARA OBTER DASHBOARD DE VAGAS
app.get("/dashboard", async (req, res) => {
    try {
        await dbReady;
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
        await dbReady;
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
        await dbReady;
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
app.post("/mensalistas/pagamentos", requireAuth, async (req, res) => {
    const { mensalista_id, placa, nome, meses = 1, observacao, pagamentos = [] } = req.body || {};
    const placaNorm = placa ? sanitizePlate(placa) : null;
    const mesesInt = Math.max(1, parseInt(meses, 10) || 1);

    const pagamentosNormalizados = (Array.isArray(pagamentos) ? pagamentos : [])
        .map((p) => ({
            forma_pagamento: normalizePaymentMethod(p?.forma_pagamento),
            valor_pago: Number(p?.valor_pago || 0)
        }))
        .filter((p) => p.forma_pagamento && p.valor_pago > 0);

    if (pagamentosNormalizados.length === 0) {
        return res.status(400).json({ error: 'Informe ao menos uma forma de pagamento válida' });
    }

    try {
        await dbReady;
        const mensalistaResult = await query(
            `SELECT * FROM mensalistas WHERE id = $1 OR placa = $2 LIMIT 1`,
            [mensalista_id || null, placaNorm || '']
        );
        const mensalista = mensalistaResult.rows?.[0];
        if (!mensalista) {
            return res.status(404).json({ error: 'Mensalista não encontrado' });
        }

        const totalPago = pagamentosNormalizados.reduce((acc, cur) => acc + cur.valor_pago, 0);
        const now = new Date();
        const data_pagamento = formatDateLocal(now);
        const hora_pagamento = formatTimeLocal(now);
        const vencAtual = mensalista.vencimento ? String(mensalista.vencimento).slice(0, 10) : null;
        const baseVenc = vencAtual && vencAtual >= data_pagamento ? vencAtual : data_pagamento;
        const novoVencimento = addMonthsToISODate(baseVenc, mesesInt);

        await tx(async (client) => {
            for (const p of pagamentosNormalizados) {
                await client.query(
                    `INSERT INTO caixa_movimentos (
                        origem, mensalista_id, placa, nome, valor_pago, forma_pagamento,
                        data_pagamento, hora_pagamento, observacao
                    ) VALUES ('mensalidade', $1, $2, $3, $4, $5, $6, $7, $8)`,
                    [
                        mensalista.id,
                        mensalista.placa,
                        nome || mensalista.nome || null,
                        p.valor_pago,
                        p.forma_pagamento,
                        data_pagamento,
                        hora_pagamento,
                        observacao || null
                    ]
                );
            }

            await client.query(
                `UPDATE mensalistas SET vencimento = $1, atualizado_em = NOW() WHERE id = $2`,
                [novoVencimento, mensalista.id]
            );
        });

        await logAudit('mensalidade_pagamento', {
            mensalista_id: mensalista.id,
            placa: mensalista.placa,
            total: totalPago,
            pagamentos: pagamentosNormalizados,
            meses: mesesInt,
            novo_vencimento: novoVencimento
        });

        return res.json({
            success: true,
            total_pago: totalPago,
            novo_vencimento: novoVencimento
        });
    } catch (err) {
        console.error('[BACK] Erro ao registrar pagamento mensalidade:', err);
        return res.status(500).json({ error: 'Erro ao registrar pagamento da mensalidade' });
    }
});
    }
});

// ROTA PARA ATUALIZAR CONFIGURAÇÕES
app.put("/configuracoes", requireAuth, async (req, res) => {
    const configuracoes = req.body;
    
    if (!configuracoes || typeof configuracoes !== 'object') {
        return res.status(400).json({ error: "Configurações inválidas" });
    }
    
    const chaves = Object.keys(configuracoes);
    let processadas = 0;
    let erros = [];
    
    if (chaves.length === 0) {
        return res.status(400).json({ error: "Nenhuma configuração para atualizar" });
    }
    
    try {
        await dbReady;

        for (const chave of chaves) {
            const valor = configuracoes[chave];

            const result = await query(
                `UPDATE configuracoes SET valor = $1, atualizado_em = NOW() WHERE chave = $2`,
                [String(valor), chave]
            );

            processadas++;

            if (result.rowCount === 0) {
                erros.push({ chave, erro: "Configuração não encontrada" });
            } else {
                console.log(`[BACK] Configuração atualizada: ${chave} = ${valor}`);
            }
        }

        if (erros.length > 0) {
            return res.status(400).json({ 
                success: false, 
                mensagem: "Algumas configurações não foram atualizadas",
                erros 
            });
        }

        await logAudit('configuracoes_update', { chaves });

        return res.json({ 
            success: true, 
            mensagem: "Configurações atualizadas com sucesso" 
        });
    } catch (err) {
        console.error("[BACK] Erro ao atualizar configurações:", err);
        return res.status(500).json({ error: "Erro ao atualizar configurações" });
    }
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
        await dbReady;
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
        await dbReady;
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
    if (!placaNorm || !nome) return res.status(400).json({ error: 'Placa e nome são obrigatórios' });

    try {
        await dbReady;
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
        await dbReady;
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
        await dbReady;
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

// REGISTRAR PAGAMENTO DE MENSALIDADE
app.post("/mensalistas/pagamentos", requireAuth, async (req, res) => {
    const { mensalista_id, placa, nome, meses = 1, observacao, pagamentos = [] } = req.body || {};
    const placaNorm = placa ? sanitizePlate(placa) : null;
    const mesesInt = Math.max(1, parseInt(meses, 10) || 1);

    const pagamentosNormalizados = (Array.isArray(pagamentos) ? pagamentos : [])
        .map((p) => ({
            forma_pagamento: normalizePaymentMethod(p?.forma_pagamento),
            valor_pago: Number(p?.valor_pago || 0)
        }))
        .filter((p) => p.forma_pagamento && p.valor_pago > 0);

    if (pagamentosNormalizados.length === 0) {
        return res.status(400).json({ error: 'Informe ao menos uma forma de pagamento válida' });
    }

    try {
        await dbReady;
        const mensalistaResult = await query(
            `SELECT * FROM mensalistas WHERE id = $1 OR placa = $2 LIMIT 1`,
            [mensalista_id || null, placaNorm || '']
        );
        const mensalista = mensalistaResult.rows?.[0];
        if (!mensalista) {
            return res.status(404).json({ error: 'Mensalista não encontrado' });
        }

        const totalPago = pagamentosNormalizados.reduce((acc, cur) => acc + cur.valor_pago, 0);
        const now = new Date();
        const data_pagamento = formatDateLocal(now);
        const hora_pagamento = formatTimeLocal(now);
        const vencAtual = mensalista.vencimento ? String(mensalista.vencimento).slice(0, 10) : null;
        const baseVenc = vencAtual && vencAtual >= data_pagamento ? vencAtual : data_pagamento;
        const novoVencimento = addMonthsToISODate(baseVenc, mesesInt);

        await tx(async (client) => {
            for (const p of pagamentosNormalizados) {
                await client.query(
                    `INSERT INTO caixa_movimentos (
                        origem, mensalista_id, placa, nome, valor_pago, forma_pagamento,
                        data_pagamento, hora_pagamento, observacao
                    ) VALUES ('mensalidade', $1, $2, $3, $4, $5, $6, $7, $8)`,
                    [
                        mensalista.id,
                        mensalista.placa,
                        nome || mensalista.nome || null,
                        p.valor_pago,
                        p.forma_pagamento,
                        data_pagamento,
                        hora_pagamento,
                        observacao || null
                    ]
                );
            }

            await client.query(
                `UPDATE mensalistas SET vencimento = $1, atualizado_em = NOW() WHERE id = $2`,
                [novoVencimento, mensalista.id]
            );
        });

        await logAudit('mensalidade_pagamento', {
            mensalista_id: mensalista.id,
            placa: mensalista.placa,
            total: totalPago,
            pagamentos: pagamentosNormalizados,
            meses: mesesInt,
            novo_vencimento: novoVencimento
        });

        return res.json({
            success: true,
            total_pago: totalPago,
            novo_vencimento: novoVencimento
        });
    } catch (err) {
        console.error('[BACK] Erro ao registrar pagamento mensalidade:', err);
        return res.status(500).json({ error: 'Erro ao registrar pagamento da mensalidade' });
    }
});

// HISTÓRICO DE PAGAMENTOS DE MENSALIDADE
app.get("/mensalistas/:id/pagamentos", requireAuth, async (req, res) => {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
    try {
        await dbReady;
        const result = await query(
            `SELECT
                id,
                mensalista_id,
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
        await dbReady;
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

// BACKUP / RESTORE
app.get("/backup", requireAuth, async (req, res) => {
    try {
        await dbReady;
        const historico = await query(`SELECT * FROM historico`, []);
        const configuracoes = await query(`SELECT * FROM configuracoes`, []);
        const mensalistas = await query(`SELECT * FROM mensalistas`, []);
        const caixaMovimentos = await query(`SELECT * FROM caixa_movimentos`, []);
        const payload = {
            historico: historico.rows || [],
            configuracoes: configuracoes.rows || [],
            mensalistas: mensalistas.rows || [],
            caixa_movimentos: caixaMovimentos.rows || []
        };
        await logAudit('backup_export', { total_historico: payload.historico.length });
        res.json({ success: true, dados: payload });
    } catch (err) {
        console.error('[BACK] Erro ao gerar backup:', err);
        return res.status(500).json({ error: 'Erro ao gerar backup' });
    }
});

app.post("/restore", requireAuth, async (req, res) => {
    const { historico = [], configuracoes = [], mensalistas = [], caixa_movimentos = [] } = req.body || {};
    try {
        await dbReady;
        await tx(async (client) => {
            await client.query('DELETE FROM historico');
            await client.query('DELETE FROM configuracoes');
            await client.query('DELETE FROM mensalistas');
            await client.query('DELETE FROM caixa_movimentos');

            for (const row of configuracoes) {
                await client.query(
                    `INSERT INTO configuracoes (id, chave, valor, descricao, atualizado_em)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, descricao = EXCLUDED.descricao, atualizado_em = EXCLUDED.atualizado_em`,
                    [row.id || null, row.chave, row.valor, row.descricao || null, row.atualizado_em || new Date().toISOString()]
                );
            }

            for (const row of mensalistas) {
                await client.query(
                    `INSERT INTO mensalistas (id, placa, nome, telefone, cpf, vencimento, ativo, criado_em, atualizado_em)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                     ON CONFLICT (placa) DO UPDATE SET
                        nome = EXCLUDED.nome,
                        telefone = EXCLUDED.telefone,
                        cpf = EXCLUDED.cpf,
                        vencimento = EXCLUDED.vencimento,
                        ativo = EXCLUDED.ativo,
                        atualizado_em = EXCLUDED.atualizado_em`,
                    [row.id || null, row.placa, row.nome, row.telefone || null, row.cpf || null, row.vencimento || null, row.ativo !== false, row.criado_em || new Date().toISOString(), row.atualizado_em || new Date().toISOString()]
                );
            }

            for (const row of historico) {
                await client.query(
                    `INSERT INTO historico (
                        id, entry_id, placa, marca, modelo, cor, mensalista, diarista, cliente_nome, cliente_telefone, cliente_cpf,
                        data_entrada, hora_entrada, data_saida, hora_saida, tempo_permanencia, valor_pago, forma_pagamento, status, criado_em
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
                    [
                        row.id || null,
                        row.entry_id || null,
                        row.placa,
                        row.marca || '',
                        row.modelo || '',
                        row.cor || '',
                        row.mensalista === true,
                        row.diarista === true,
                        row.cliente_nome || null,
                        row.cliente_telefone || null,
                        row.cliente_cpf || null,
                        row.data_entrada || null,
                        row.hora_entrada || null,
                        row.data_saida || null,
                        row.hora_saida || null,
                        row.tempo_permanencia || null,
                        row.valor_pago || 0,
                        row.forma_pagamento || null,
                        row.status || 'ativo',
                        row.criado_em || new Date().toISOString()
                    ]
                );
            }

            for (const row of caixa_movimentos) {
                await client.query(
                    `INSERT INTO caixa_movimentos (
                        id, origem, historico_id, mensalista_id, placa, nome, valor_pago, forma_pagamento,
                        data_pagamento, hora_pagamento, observacao, criado_em
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                    [
                        row.id || null,
                        row.origem,
                        row.historico_id || null,
                        row.mensalista_id || null,
                        row.placa || null,
                        row.nome || null,
                        row.valor_pago || 0,
                        row.forma_pagamento || null,
                        row.data_pagamento || null,
                        row.hora_pagamento || null,
                        row.observacao || null,
                        row.criado_em || new Date().toISOString()
                    ]
                );
            }
        });
        await logAudit('backup_restore', { total_historico: historico.length });
        res.json({ success: true, mensagem: 'Restore concluído' });
    } catch (err) {
        console.error('[BACK] Erro ao restaurar backup:', err);
        return res.status(500).json({ error: 'Erro ao restaurar backup' });
    }
});

// INICIAR SERVIDOR com fallback se a porta estiver ocupada
const BASE_PORT = parseInt(process.env.PORT, 10) || 3000;

function startServer(port, retries = 5) {
    const server = app.listen(port, () => {
        console.log(`Servidor rodando na porta ${port}`);
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && retries > 0) {
            const nextPort = port + 1;
            console.warn(`[BACK] Porta ${port} ocupada. Tentando ${nextPort}...`);
            startServer(nextPort, retries - 1);
        } else {
            console.error('[BACK] Falha ao iniciar servidor:', err);
            process.exit(1);
        }
    });
}

if (!process.env.VERCEL) {
    startServer(BASE_PORT);
}

export { app };
export default app;
