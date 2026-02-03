import pg from "pg";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.warn("[BACK] DATABASE_URL não definido. Configure no ambiente para conectar ao Postgres.");
}

const pool = new Pool({
    connectionString,
    ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function initDb() {
    const schemaPath = resolve(__dirname, "schema.sql");
    const sql = await fs.readFile(schemaPath, "utf8");
    await pool.query(sql);
    await pool.query(`ALTER TABLE IF EXISTS historico ADD COLUMN IF NOT EXISTS mensalista BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE IF EXISTS historico ADD COLUMN IF NOT EXISTS diarista BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE IF EXISTS historico ADD COLUMN IF NOT EXISTS cliente_nome VARCHAR(120)`);
    await pool.query(`ALTER TABLE IF EXISTS historico ADD COLUMN IF NOT EXISTS cliente_telefone VARCHAR(40)`);
    await pool.query(`ALTER TABLE IF EXISTS historico ADD COLUMN IF NOT EXISTS cliente_cpf VARCHAR(20)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS mensalistas (
        id BIGSERIAL PRIMARY KEY,
        placa VARCHAR(16) UNIQUE NOT NULL,
        nome VARCHAR(120) NOT NULL,
        telefone VARCHAR(40),
        cpf VARCHAR(20),
        vencimento DATE,
        ativo BOOLEAN NOT NULL DEFAULT TRUE,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mensalistas_placa ON mensalistas(placa)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mensalistas_cpf ON mensalistas(cpf)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS auditoria (
        id BIGSERIAL PRIMARY KEY,
        acao VARCHAR(120) NOT NULL,
        detalhes JSONB,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS caixa_movimentos (
        id BIGSERIAL PRIMARY KEY,
        origem VARCHAR(32) NOT NULL,
        historico_id BIGINT,
        mensalista_id BIGINT,
        placa VARCHAR(16),
        nome VARCHAR(120),
        valor_pago NUMERIC(10,2) NOT NULL,
        forma_pagamento VARCHAR(60),
        data_pagamento DATE NOT NULL DEFAULT CURRENT_DATE,
        hora_pagamento TIME NOT NULL DEFAULT CURRENT_TIME,
        observacao VARCHAR(255),
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`ALTER TABLE IF EXISTS caixa_movimentos ADD COLUMN IF NOT EXISTS origem VARCHAR(32)`);
    await pool.query(`ALTER TABLE IF EXISTS caixa_movimentos ADD COLUMN IF NOT EXISTS historico_id BIGINT`);
    await pool.query(`ALTER TABLE IF EXISTS caixa_movimentos ADD COLUMN IF NOT EXISTS mensalista_id BIGINT`);
    await pool.query(`ALTER TABLE IF EXISTS caixa_movimentos ADD COLUMN IF NOT EXISTS placa VARCHAR(16)`);
    await pool.query(`ALTER TABLE IF EXISTS caixa_movimentos ADD COLUMN IF NOT EXISTS nome VARCHAR(120)`);
    await pool.query(`ALTER TABLE IF EXISTS caixa_movimentos ADD COLUMN IF NOT EXISTS valor_pago NUMERIC(10,2)`);
    await pool.query(`ALTER TABLE IF EXISTS caixa_movimentos ADD COLUMN IF NOT EXISTS forma_pagamento VARCHAR(60)`);
    await pool.query(`ALTER TABLE IF EXISTS caixa_movimentos ADD COLUMN IF NOT EXISTS data_pagamento DATE`);
    await pool.query(`ALTER TABLE IF EXISTS caixa_movimentos ADD COLUMN IF NOT EXISTS hora_pagamento TIME`);
    await pool.query(`ALTER TABLE IF EXISTS caixa_movimentos ADD COLUMN IF NOT EXISTS observacao VARCHAR(255)`);
    await pool.query(`ALTER TABLE IF EXISTS caixa_movimentos ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_data ON caixa_movimentos(data_pagamento)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_forma ON caixa_movimentos(forma_pagamento)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_origem ON caixa_movimentos(origem)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_hist ON caixa_movimentos(historico_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_mensalista ON caixa_movimentos(mensalista_id)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS caixa_fechamentos (
        id BIGSERIAL PRIMARY KEY,
        data_ref DATE NOT NULL UNIQUE,
        total_recebido NUMERIC(10,2) NOT NULL DEFAULT 0,
        total_dinheiro NUMERIC(10,2) NOT NULL DEFAULT 0,
        total_credito NUMERIC(10,2) NOT NULL DEFAULT 0,
        total_debito NUMERIC(10,2) NOT NULL DEFAULT 0,
        total_pix NUMERIC(10,2) NOT NULL DEFAULT 0,
        total_transacoes INTEGER NOT NULL DEFAULT 0,
        observacao VARCHAR(255),
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_caixa_fechamentos_data ON caixa_fechamentos(data_ref)`);
    console.log("[BACK] Schema aplicado com sucesso");
}

export async function query(text, params = []) {
    return pool.query(text, params);
}

export async function tx(work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}
