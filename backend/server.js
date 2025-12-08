import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import sqlite3 from "sqlite3";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Banco de dados SQLite
const db = new sqlite3.Database(`${__dirname}/estacionamento.db`, (err) => {
    if (err) console.error("[BACK] Erro ao abrir DB:", err);
    else console.log("[BACK] Banco de dados conectado");
});

// Criar tabela se não existir
db.run(`
    CREATE TABLE IF NOT EXISTS historico (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        status TEXT DEFAULT 'ativo',
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// API gratuita (sem credencial) para consulta de placa
// Fonte: apicarros.com - retorna marca, modelo, cor, etc.
const FREE_API = 'https://apicarros.com/v1/consulta';

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

// ROTA PARA REGISTRAR ENTRADA DE VEÍCULO
app.post("/entrada", (req, res) => {
    let { placa, marca, modelo, cor } = req.body;
    
    if (!placa) {
        return res.status(400).json({ error: "Placa é obrigatória" });
    }
    
    // Normaliza placa para maiúsculas
    placa = sanitizePlate(placa);

    const now = new Date();
    const data_entrada = now.toLocaleDateString('pt-BR');
    const hora_entrada = now.toLocaleTimeString('pt-BR');

    db.run(
        `INSERT INTO historico (placa, marca, modelo, cor, data_entrada, hora_entrada, status)
         VALUES (?, ?, ?, ?, ?, ?, 'ativo')`,
        [placa, marca || '', modelo || '', cor || '', data_entrada, hora_entrada],
        function(err) {
            if (err) {
                console.error("[BACK] Erro ao registrar entrada:", err);
                return res.status(500).json({ error: "Erro ao registrar entrada" });
            }
            res.json({ 
                success: true, 
                id: this.lastID,
                mensagem: "Entrada registrada com sucesso"
            });
        }
    );
});

// ROTA PARA REGISTRAR SAÍDA DE VEÍCULO
app.post("/saida", (req, res) => {
    let { placa, valor_pago, tempo_permanencia } = req.body;
    
    if (!placa) {
        return res.status(400).json({ error: "Placa é obrigatória" });
    }
    
    // Normaliza placa para maiúsculas
    placa = sanitizePlate(placa);

    const now = new Date();
    const data_saida = now.toLocaleDateString('pt-BR');
    const hora_saida = now.toLocaleTimeString('pt-BR');
    
    console.log(`[BACK] Registrando saída - Placa: ${placa}, Valor: ${valor_pago}, Tempo: ${tempo_permanencia}`);

    db.run(
        `UPDATE historico 
         SET data_saida = ?, hora_saida = ?, valor_pago = ?, tempo_permanencia = ?, status = 'saído'
         WHERE placa = ? AND status = 'ativo'`,
        [data_saida, hora_saida, valor_pago || 0, tempo_permanencia || '', placa],
        function(err) {
            if (err) {
                console.error("[BACK] Erro ao registrar saída:", err);
                return res.status(500).json({ error: "Erro ao registrar saída" });
            }
            if (this.changes === 0) {
                console.warn(`[BACK] Veículo não encontrado: ${placa}`);
                return res.status(404).json({ error: "Veículo não encontrado ou já saiu" });
            }
            console.log(`[BACK] Saída registrada com sucesso - Placa: ${placa}, Alterações: ${this.changes}`);
            res.json({ 
                success: true,
                mensagem: "Saída registrada com sucesso",
                placa: placa,
                data_saida: data_saida,
                hora_saida: hora_saida,
                valor_pago: valor_pago
            });
        }
    );
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
