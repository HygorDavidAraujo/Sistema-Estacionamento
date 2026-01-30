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
