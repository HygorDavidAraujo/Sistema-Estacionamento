import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { initDb, query } from "./db.js";
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

const dbReady = initDb().catch((err) => {
    console.error("[BACK] Falha ao inicializar schema:", err);
});

// API gratuita (sem credencial) para consulta de placa
// Fonte: apicarros.com - retorna marca, modelo, cor, etc.
const FREE_API = 'https://apicarros.com/v1/consulta';

function pad2(n) {
    return String(n).padStart(2, "0");
}

function formatDateLocal(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatTimeLocal(date) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function sanitizePlate(p) {
    if (!p) return '';
    return String(p).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
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
app.post("/entrada", async (req, res) => {
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
app.post("/saida", async (req, res) => {
    let { placa, valor_pago, tempo_permanencia, forma_pagamento, entryId } = req.body;
    
    if (!placa && !entryId) {
        return res.status(400).json({ error: "Placa ou entryId é obrigatório" });
    }
    
    if (!forma_pagamento && valor_pago > 0) {
        return res.status(400).json({ error: "Forma de pagamento é obrigatória quando há valor a pagar" });
    }
    
    const placaNorm = placa ? sanitizePlate(placa) : null;
    const entry_id = entryId || null;

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
        return result.rowCount || 0;
    };

    const finalize = (targetPlaca) => {
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
            const changes = await tryUpdate('entry_id = $6', entry_id);
            if (changes === 0 && placaNorm) {
                // Fallback pela placa se entryId não encontrar
                const changes2 = await tryUpdate('placa = $6', placaNorm);
                if (changes2 === 0) {
                    console.warn(`[BACK] Veículo não encontrado (entryId/placa): ${entry_id}/${placaNorm}`);
                    return res.status(404).json({ error: "Veículo não encontrado ou já saiu" });
                }
                return finalize(placaNorm);
            }

            if (changes === 0) {
                console.warn(`[BACK] Veículo não encontrado para entryId: ${entry_id}`);
                return res.status(404).json({ error: "Veículo não encontrado ou já saiu" });
            }
            return finalize(placaNorm);
        }

        const changes = await tryUpdate('placa = $6', placaNorm);
        if (changes === 0) {
            console.warn(`[BACK] Veículo não encontrado: ${placaNorm}`);
            return res.status(404).json({ error: "Veículo não encontrado ou já saiu" });
        }
        return finalize(placaNorm);
    } catch (err) {
        console.error("[BACK] Erro ao registrar saída:", err);
        return res.status(500).json({ error: "Erro ao registrar saída" });
    }
});

// ROTA PARA OBTER HISTÓRICO COMPLETO
app.get("/historico", async (req, res) => {
    const { dataInicio, dataFim, dia, mes, ano, tipo } = req.query;
    
    let query = `
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
        query += ` AND data_entrada BETWEEN ${addParam(dataInicio)} AND ${addParam(dataFim)}`;
    }
    // Filtro por dia, mês e ano
    else if (dia && mes && ano) {
        query += ` AND EXTRACT(DAY FROM data_entrada) = ${addParam(parseInt(dia, 10))} AND EXTRACT(MONTH FROM data_entrada) = ${addParam(parseInt(mes, 10))} AND EXTRACT(YEAR FROM data_entrada) = ${addParam(parseInt(ano, 10))}`;
    }
    // Filtro por mês e ano
    else if (mes && ano) {
        query += ` AND EXTRACT(MONTH FROM data_entrada) = ${addParam(parseInt(mes, 10))} AND EXTRACT(YEAR FROM data_entrada) = ${addParam(parseInt(ano, 10))}`;
    }
    // Filtro apenas por ano
    else if (ano) {
        query += ` AND EXTRACT(YEAR FROM data_entrada) = ${addParam(parseInt(ano, 10))}`;
    }
    // Filtro apenas por dia (todos os meses/anos)
    else if (dia) {
        query += ` AND EXTRACT(DAY FROM data_entrada) = ${addParam(parseInt(dia, 10))}`;
    }

    if (tipo === 'mensalista') {
        query += ` AND mensalista = ${addParam(true)}`;
    } else if (tipo === 'diarista') {
        query += ` AND diarista = ${addParam(true)}`;
    } else if (tipo === 'avulso') {
        query += ` AND mensalista = false AND diarista = false`;
    }
    
    query += ` ORDER BY criado_em DESC`;
    
    try {
        await dbReady;
        const result = await query(query, params);
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

// ROTA PARA OBTER RELATÓRIO RESUMIDO (ESTATÍSTICAS)
app.get("/relatorio/resumo", async (req, res) => {
    const { tipo } = req.query;
    try {
        await dbReady;
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

// ROTA PARA OBTER DASHBOARD DE CAIXA
app.get("/caixa/dashboard", async (req, res) => {
    const hoje = formatDateLocal(new Date());
    
    try {
        await dbReady;
        const result = await query(
            `SELECT 
                COALESCE(SUM(valor_pago), 0) as total_recebido,
                COALESCE(SUM(CASE WHEN forma_pagamento = 'Dinheiro' THEN valor_pago ELSE 0 END), 0) as total_dinheiro,
                COALESCE(SUM(CASE WHEN forma_pagamento = 'Cartão de Crédito' THEN valor_pago ELSE 0 END), 0) as total_credito,
                COALESCE(SUM(CASE WHEN forma_pagamento = 'Cartão de Débito' THEN valor_pago ELSE 0 END), 0) as total_debito,
                COALESCE(SUM(CASE WHEN forma_pagamento = 'Pix' THEN valor_pago ELSE 0 END), 0) as total_pix,
                COUNT(CASE WHEN valor_pago > 0 THEN 1 END) as total_transacoes
             FROM historico 
             WHERE status = 'saído' AND data_saida = $1`,
            [hoje]
        );
        res.json({ success: true, dados: result.rows?.[0] || {} });
    } catch (err) {
        console.error("[BACK] Erro ao gerar dashboard de caixa:", err);
        return res.status(500).json({ error: "Erro ao gerar dashboard de caixa" });
    }
});

// ROTA PARA RELATÓRIO DE CAIXA POR PERÍODO
app.get("/caixa/relatorio", async (req, res) => {
    const { dataInicio, dataFim } = req.query;
    
    let query = `
        SELECT 
            TO_CHAR(data_saida, 'DD/MM/YYYY') as data_saida,
            forma_pagamento,
            COUNT(*) as quantidade,
            COALESCE(SUM(valor_pago), 0) as total
        FROM historico 
        WHERE status = 'saído'
    `;
    
    let params = [];
    
    if (dataInicio && dataFim) {
        query += ` AND data_saida BETWEEN $1 AND $2`;
        params.push(dataInicio, dataFim);
    } else if (dataInicio) {
        query += ` AND data_saida >= $1`;
        params.push(dataInicio);
    } else if (dataFim) {
        query += ` AND data_saida <= $1`;
        params.push(dataFim);
    }
    
    query += ` GROUP BY data_saida, forma_pagamento ORDER BY data_saida DESC, forma_pagamento`;
    
    try {
        await dbReady;
        const result = await query(query, params);
        res.json({ success: true, dados: result.rows || [] });
    } catch (err) {
        console.error("[BACK] Erro ao gerar relatório de caixa:", err);
        return res.status(500).json({ error: "Erro ao gerar relatório de caixa" });
    }
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
    }
});

// ROTA PARA ATUALIZAR CONFIGURAÇÕES
app.put("/configuracoes", async (req, res) => {
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

        return res.json({ 
            success: true, 
            mensagem: "Configurações atualizadas com sucesso" 
        });
    } catch (err) {
        console.error("[BACK] Erro ao atualizar configurações:", err);
        return res.status(500).json({ error: "Erro ao atualizar configurações" });
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
