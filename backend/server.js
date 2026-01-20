import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import sqlite3 from "sqlite3";
import multer from "multer";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

// Banco de dados SQLite
const db = new sqlite3.Database(`${__dirname}/estacionamento.db`, (err) => {
    if (err) console.error("[BACK] Erro ao abrir DB:", err);
    else console.log("[BACK] Banco de dados conectado");
});

// Criar tabelas se não existirem
db.serialize(() => {
    // Tabela histórico
    db.run(`
        CREATE TABLE IF NOT EXISTS historico (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id TEXT,
            placa TEXT NOT NULL,
            marca TEXT,
            modelo TEXT,
            cor TEXT,
            data_entrada TEXT NOT NULL,
            hora_entrada TEXT NOT NULL,
            data_saida TEXT,
            hora_saida TEXT,
            tempo_permanencia TEXT,
            valor_pago REAL,
            forma_pagamento TEXT,
            status TEXT DEFAULT 'ativo',
            criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) console.error('[BACK] Erro ao criar tabela historico:', err);
        else console.log('[BACK] Tabela historico pronta');
    });

    // Garante índice único para entry_id (permite múltiplos NULLs)
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_historico_entry_id ON historico(entry_id)`);

    // Tabela configurações
    db.run(`
        CREATE TABLE IF NOT EXISTS configuracoes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chave TEXT UNIQUE NOT NULL,
            valor TEXT NOT NULL,
            descricao TEXT,
            atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) {
            console.error('[BACK] Erro ao criar tabela configuracoes:', err);
            return;
        }
        
        console.log('[BACK] Tabela configuracoes pronta');
        
        // Inserir configurações padrão se não existirem (dentro do callback)
        const configuracoesDefault = [
            { chave: 'valor_hora_inicial', valor: '5.00', descricao: 'Valor da primeira hora (R$)' },
            { chave: 'valor_hora_adicional', valor: '2.50', descricao: 'Valor por hora adicional (R$)' },
            { chave: 'tempo_tolerancia', valor: '15', descricao: 'Tempo de tolerância em minutos' },
            { chave: 'total_vagas', valor: '50', descricao: 'Número total de vagas do estacionamento' }
        ];

        configuracoesDefault.forEach(config => {
            db.run(
                `INSERT OR IGNORE INTO configuracoes (chave, valor, descricao) VALUES (?, ?, ?)`,
                [config.chave, config.valor, config.descricao],
                (err) => {
                    if (err) console.error(`[BACK] Erro ao inserir config ${config.chave}:`, err);
                    else console.log(`[BACK] Config ${config.chave} inicializada`);
                }
            );
        });
    });
});

// API gratuita (sem credencial) para consulta de placa
// Fonte: apicarros.com - retorna marca, modelo, cor, etc.
const FREE_API = 'https://apicarros.com/v1/consulta';

// Garante que a coluna entry_id exista (migração leve)
function ensureEntryIdColumn() {
    db.all(`PRAGMA table_info(historico)`, (err, rows) => {
        if (err) {
            console.error('[BACK] Erro ao inspecionar tabela historico:', err);
            return;
        }
        const hasEntryId = rows.some(r => r.name === 'entry_id');
        if (!hasEntryId) {
            db.run(`ALTER TABLE historico ADD COLUMN entry_id TEXT`, (alterErr) => {
                if (alterErr) console.error('[BACK] Erro ao adicionar entry_id:', alterErr);
                else console.log('[BACK] Coluna entry_id adicionada');
            });
        }
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_historico_entry_id ON historico(entry_id)`);
    });
}

ensureEntryIdColumn();

function sanitizePlate(p) {
    if (!p) return '';
    return String(p).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

// ROTA PARA CONSULTAR A PLACA (API gratuita)
app.get("/placa/:placa", async (req, res) => {
    const placa = sanitizePlate(req.params.placa);
    console.log("[BACK] Consultando placa:", placa);

    if (placa.length < 7) {
        return res.status(400).json({ error: "Placa inválida", encontrado: false });
    }

    try {
        const url = `${FREE_API}/${encodeURIComponent(placa)}.json`;
        console.log('[BACK] URL Dados:', url);

        const resp = await fetch(url, { 
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        if (!resp.ok) {
            console.warn('[BACK] API retornou status:', resp.status);
            // Retorna resposta vazia mas válida para permitir entrada manual
            return res.json({
                encontrado: false,
                marca: "",
                modelo: "",
                cor: "",
                mensagem: "API indisponível. Preencha manualmente."
            });
        }

        const data = await resp.json();

        // Alguns retornos podem indicar erro na própria resposta
        if (data?.codigoRetorno && data.codigoRetorno !== "0") {
            console.warn('[BACK] API retornou código de erro:', data.codigoRetorno);
            return res.json({
                encontrado: false,
                marca: "",
                modelo: "",
                cor: "",
                mensagem: "Placa não encontrada. Preencha manualmente."
            });
        }

        const marca = data?.marca || "";
        const modelo = data?.modelo || "";
        const cor = data?.cor || "";

        if (!marca && !modelo) {
            return res.json({
                encontrado: false,
                marca: "",
                modelo: "",
                cor: "",
                mensagem: "Dados não encontrados. Preencha manualmente."
            });
        }

        return res.json({
            encontrado: true,
            marca,
            modelo,
            cor
        });

    } catch (error) {
        console.error("[BACK] ERRO AO CONSULTAR:", error);
        // Retorna resposta válida mesmo com erro para não bloquear o sistema
        return res.json({
            encontrado: false,
            marca: "",
            modelo: "",
            cor: "",
            mensagem: "Erro na API. Preencha manualmente."
        });
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

    if (!providerUrl) {
        return res.json({ placa: null, mensagem: 'Serviço de OCR não configurado no backend (defina ANPR_URL).' });
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
            return res.json({ placa: null, mensagem: 'Provider ANPR indisponível.' });
        }

        const data = await resp.json().catch(() => ({}));
        const placa = sanitizePlate(data?.placa || data?.plate || data?.results?.[0]?.plate);
        if (placa) return res.json({ placa, origem: 'provider' });

        return res.json({ placa: null, mensagem: 'Placa não reconhecida.' });
    } catch (err) {
        console.error('[BACK] Erro no reconhecimento de placa:', err);
        return res.json({ placa: null, mensagem: 'Erro ao processar a imagem.' });
    }
});

// ROTA PARA REGISTRAR ENTRADA DE VEÍCULO
app.post("/entrada", (req, res) => {
    let { placa, marca, modelo, cor, entryId } = req.body;
    
    if (!placa) {
        return res.status(400).json({ error: "Placa é obrigatória" });
    }
    
    // Normaliza placa para maiúsculas
    placa = sanitizePlate(placa);
    const entry_id = entryId || `ent-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    // Verifica capacidade disponível
    db.get(`SELECT valor FROM configuracoes WHERE chave = 'total_vagas'`, [], (err, config) => {
        if (err) {
            console.error("[BACK] Erro ao consultar total de vagas:", err);
            return res.status(500).json({ error: "Erro ao verificar capacidade" });
        }

        const totalVagas = parseInt(config?.valor || 0);

        db.get(`SELECT COUNT(*) as ocupadas FROM historico WHERE status = 'ativo'`, [], (err, result) => {
            if (err) {
                console.error("[BACK] Erro ao contar vagas ocupadas:", err);
                return res.status(500).json({ error: "Erro ao verificar ocupação" });
            }

            const ocupadas = result.ocupadas || 0;

            if (ocupadas >= totalVagas) {
                return res.status(400).json({ 
                    error: "Estacionamento lotado",
                    mensagem: `Capacidade máxima atingida (${totalVagas} vagas)`
                });
            }

            // Procede com a entrada
            const now = new Date();
            const data_entrada = now.toLocaleDateString('pt-BR');
            const hora_entrada = now.toLocaleTimeString('pt-BR');

            db.run(
                `INSERT INTO historico (entry_id, placa, marca, modelo, cor, data_entrada, hora_entrada, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'ativo')`,
                [entry_id, placa, marca || '', modelo || '', cor || '', data_entrada, hora_entrada],
                function(err) {
                    if (err) {
                        if (String(err?.message || '').includes('UNIQUE constraint failed: historico.entry_id')) {
                            return res.status(409).json({ error: 'ID de entrada já existe' });
                        }
                        console.error("[BACK] Erro ao registrar entrada:", err);
                        return res.status(500).json({ error: "Erro ao registrar entrada" });
                    }
                    res.json({ 
                        success: true, 
                        id: this.lastID,
                        entry_id,
                        mensagem: "Entrada registrada com sucesso"
                    });
                }
            );
        });
    });
});

// ROTA PARA REGISTRAR SAÍDA DE VEÍCULO
app.post("/saida", (req, res) => {
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
    const data_saida = now.toLocaleDateString('pt-BR');
    const hora_saida = now.toLocaleTimeString('pt-BR');
    
    console.log(`[BACK] Registrando saída - entryId: ${entry_id || '-'} Placa: ${placaNorm || '-'}, Valor: ${valor_pago}, Tempo: ${tempo_permanencia}, Forma: ${forma_pagamento}`);

    const paramsBase = [data_saida, hora_saida, valor_pago || 0, tempo_permanencia || '', forma_pagamento || null];

    const tryUpdate = (whereClause, whereValue, onDone) => {
        db.run(
            `UPDATE historico 
             SET data_saida = ?, hora_saida = ?, valor_pago = ?, tempo_permanencia = ?, forma_pagamento = ?, status = 'saído'
             WHERE status = 'ativo' AND ${whereClause}`,
            [...paramsBase, whereValue],
            function(err) {
                onDone(err, this.changes);
            }
        );
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

    if (entry_id) {
        tryUpdate('entry_id = ?', entry_id, (err, changes) => {
            if (err) {
                console.error("[BACK] Erro ao registrar saída:", err);
                return res.status(500).json({ error: "Erro ao registrar saída" });
            }
            if (changes === 0 && placaNorm) {
                // Fallback pela placa se entryId não encontrar
                tryUpdate('placa = ?', placaNorm, (err2, changes2) => {
                    if (err2) {
                        console.error("[BACK] Erro ao registrar saída (fallback placa):", err2);
                        return res.status(500).json({ error: "Erro ao registrar saída" });
                    }
                    if (changes2 === 0) {
                        console.warn(`[BACK] Veículo não encontrado (entryId/placa): ${entry_id}/${placaNorm}`);
                        return res.status(404).json({ error: "Veículo não encontrado ou já saiu" });
                    }
                    finalize(placaNorm);
                });
            } else if (changes === 0) {
                console.warn(`[BACK] Veículo não encontrado para entryId: ${entry_id}`);
                return res.status(404).json({ error: "Veículo não encontrado ou já saiu" });
            } else {
                finalize(placaNorm);
            }
        });
    } else {
        tryUpdate('placa = ?', placaNorm, (err, changes) => {
            if (err) {
                console.error("[BACK] Erro ao registrar saída:", err);
                return res.status(500).json({ error: "Erro ao registrar saída" });
            }
            if (changes === 0) {
                console.warn(`[BACK] Veículo não encontrado: ${placaNorm}`);
                return res.status(404).json({ error: "Veículo não encontrado ou já saiu" });
            }
            finalize(placaNorm);
        });
    }
});

// ROTA PARA OBTER HISTÓRICO COMPLETO
app.get("/historico", (req, res) => {
    const { dataInicio, dataFim, dia, mes, ano } = req.query;
    
    let query = `SELECT * FROM historico WHERE 1=1`;
    let params = [];
    
    // Filtro por período (data início e fim)
    if (dataInicio && dataFim) {
        query += ` AND data_entrada BETWEEN ? AND ?`;
        params.push(dataInicio, dataFim);
    }
    // Filtro por dia, mês e ano
    else if (dia && mes && ano) {
        query += ` AND substr(data_entrada, 1, 2) = ? AND substr(data_entrada, 4, 2) = ? AND substr(data_entrada, 7, 4) = ?`;
        params.push(dia.padStart(2, '0'), mes.padStart(2, '0'), ano);
    }
    // Filtro por mês e ano
    else if (mes && ano) {
        query += ` AND substr(data_entrada, 4, 2) = ? AND substr(data_entrada, 7, 4) = ?`;
        params.push(mes.padStart(2, '0'), ano);
    }
    // Filtro apenas por ano
    else if (ano) {
        query += ` AND substr(data_entrada, 7, 4) = ?`;
        params.push(ano);
    }
    // Filtro apenas por dia (todos os meses/anos)
    else if (dia) {
        query += ` AND substr(data_entrada, 1, 2) = ?`;
        params.push(dia.padStart(2, '0'));
    }
    
    query += ` ORDER BY criado_em DESC`;
    
    db.all(query, params, (err, rows) => {
        if (err) {
            console.error("[BACK] Erro ao buscar histórico:", err);
            return res.status(500).json({ error: "Erro ao buscar histórico" });
        }
        res.json({ success: true, dados: rows || [] });
    });
});

// ROTA PARA OBTER HISTÓRICO FILTRADO POR PLACA
app.get("/historico/:placa", (req, res) => {
    const placa = sanitizePlate(req.params.placa);
    
    db.all(
        `SELECT * FROM historico WHERE placa = ? ORDER BY criado_em DESC`,
        [placa],
        (err, rows) => {
            if (err) {
                console.error("[BACK] Erro ao buscar histórico:", err);
                return res.status(500).json({ error: "Erro ao buscar histórico" });
            }
            res.json({ success: true, dados: rows || [] });
        }
    );
});

// ROTA PARA OBTER RELATÓRIO RESUMIDO (ESTATÍSTICAS)
app.get("/relatorio/resumo", (req, res) => {
    db.all(
        `SELECT 
            COUNT(*) as total_movimentacoes,
            COUNT(CASE WHEN status = 'saído' THEN 1 END) as total_saidas,
            COUNT(CASE WHEN status = 'ativo' THEN 1 END) as veiculos_no_patio,
            COALESCE(SUM(valor_pago), 0) as receita_total,
            COALESCE(AVG(valor_pago), 0) as valor_medio,
            COUNT(DISTINCT placa) as total_veiculos_unicos
         FROM historico`,
        [],
        (err, rows) => {
            if (err) {
                console.error("[BACK] Erro ao gerar relatório:", err);
                return res.status(500).json({ error: "Erro ao gerar relatório" });
            }
            res.json({ success: true, dados: rows[0] || {} });
        }
    );
});

// ROTA PARA OBTER DASHBOARD DE CAIXA
app.get("/caixa/dashboard", (req, res) => {
    const hoje = new Date().toLocaleDateString('pt-BR');
    
    db.get(
        `SELECT 
            COALESCE(SUM(valor_pago), 0) as total_recebido,
            COALESCE(SUM(CASE WHEN forma_pagamento = 'Dinheiro' THEN valor_pago ELSE 0 END), 0) as total_dinheiro,
            COALESCE(SUM(CASE WHEN forma_pagamento = 'Cartão de Crédito' THEN valor_pago ELSE 0 END), 0) as total_credito,
            COALESCE(SUM(CASE WHEN forma_pagamento = 'Cartão de Débito' THEN valor_pago ELSE 0 END), 0) as total_debito,
            COALESCE(SUM(CASE WHEN forma_pagamento = 'Pix' THEN valor_pago ELSE 0 END), 0) as total_pix,
            COUNT(CASE WHEN valor_pago > 0 THEN 1 END) as total_transacoes
         FROM historico 
         WHERE status = 'saído' AND data_saida = ?`,
        [hoje],
        (err, row) => {
            if (err) {
                console.error("[BACK] Erro ao gerar dashboard de caixa:", err);
                return res.status(500).json({ error: "Erro ao gerar dashboard de caixa" });
            }
            res.json({ success: true, dados: row || {} });
        }
    );
});

// ROTA PARA RELATÓRIO DE CAIXA POR PERÍODO
app.get("/caixa/relatorio", (req, res) => {
    const { dataInicio, dataFim } = req.query;
    
    let query = `
        SELECT 
            data_saida,
            forma_pagamento,
            COUNT(*) as quantidade,
            COALESCE(SUM(valor_pago), 0) as total
        FROM historico 
        WHERE status = 'saído'
    `;
    
    let params = [];
    
    if (dataInicio && dataFim) {
        query += ` AND data_saida BETWEEN ? AND ?`;
        params.push(dataInicio, dataFim);
    } else if (dataInicio) {
        query += ` AND data_saida >= ?`;
        params.push(dataInicio);
    } else if (dataFim) {
        query += ` AND data_saida <= ?`;
        params.push(dataFim);
    }
    
    query += ` GROUP BY data_saida, forma_pagamento ORDER BY data_saida DESC, forma_pagamento`;
    
    db.all(query, params, (err, rows) => {
        if (err) {
            console.error("[BACK] Erro ao gerar relatório de caixa:", err);
            return res.status(500).json({ error: "Erro ao gerar relatório de caixa" });
        }
        res.json({ success: true, dados: rows || [] });
    });
});

// ROTA PARA OBTER DASHBOARD DE VAGAS
app.get("/dashboard", (req, res) => {
    // Busca o total de vagas configurado
    db.get(`SELECT valor FROM configuracoes WHERE chave = 'total_vagas'`, [], (err, config) => {
        if (err) {
            console.error("[BACK] Erro ao buscar total de vagas:", err);
            return res.status(500).json({ error: "Erro ao buscar configuração de vagas" });
        }

        const totalVagas = parseInt(config?.valor || 0);

        // Conta veículos ativos no pátio
        db.get(`SELECT COUNT(*) as ocupadas FROM historico WHERE status = 'ativo'`, [], (err, result) => {
            if (err) {
                console.error("[BACK] Erro ao contar vagas ocupadas:", err);
                return res.status(500).json({ error: "Erro ao contar vagas ocupadas" });
            }

            const ocupadas = result.ocupadas || 0;
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
        });
    });
});

// ROTA PARA OBTER TODAS AS CONFIGURAÇÕES
app.get("/configuracoes", (req, res) => {
    db.all(
        `SELECT * FROM configuracoes ORDER BY chave`,
        [],
        (err, rows) => {
            if (err) {
                console.error("[BACK] Erro ao buscar configurações:", err);
                return res.status(500).json({ error: "Erro ao buscar configurações" });
            }
            
            // Converte array em objeto para facilitar o uso no frontend
            const configs = {};
            rows.forEach(row => {
                configs[row.chave] = {
                    valor: row.valor,
                    descricao: row.descricao,
                    atualizado_em: row.atualizado_em
                };
            });
            
            res.json({ success: true, dados: configs });
        }
    );
});

// ROTA PARA OBTER UMA CONFIGURAÇÃO ESPECÍFICA
app.get("/configuracoes/:chave", (req, res) => {
    const { chave } = req.params;
    
    db.get(
        `SELECT * FROM configuracoes WHERE chave = ?`,
        [chave],
        (err, row) => {
            if (err) {
                console.error("[BACK] Erro ao buscar configuração:", err);
                return res.status(500).json({ error: "Erro ao buscar configuração" });
            }
            if (!row) {
                return res.status(404).json({ error: "Configuração não encontrada" });
            }
            res.json({ success: true, dados: row });
        }
    );
});

// ROTA PARA ATUALIZAR CONFIGURAÇÕES
app.put("/configuracoes", (req, res) => {
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
    
    chaves.forEach(chave => {
        const valor = configuracoes[chave];
        
        db.run(
            `UPDATE configuracoes SET valor = ?, atualizado_em = CURRENT_TIMESTAMP WHERE chave = ?`,
            [String(valor), chave],
            function(err) {
                processadas++;
                
                if (err) {
                    console.error(`[BACK] Erro ao atualizar ${chave}:`, err);
                    erros.push({ chave, erro: err.message });
                } else if (this.changes === 0) {
                    erros.push({ chave, erro: "Configuração não encontrada" });
                } else {
                    console.log(`[BACK] Configuração atualizada: ${chave} = ${valor}`);
                }
                
                // Se processou todas, retorna resposta
                if (processadas === chaves.length) {
                    if (erros.length > 0) {
                        res.status(400).json({ 
                            success: false, 
                            mensagem: "Algumas configurações não foram atualizadas",
                            erros 
                        });
                    } else {
                        res.json({ 
                            success: true, 
                            mensagem: "Configurações atualizadas com sucesso" 
                        });
                    }
                }
            }
        );
    });
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

startServer(BASE_PORT);
