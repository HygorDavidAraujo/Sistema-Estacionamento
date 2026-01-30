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
    console.log("[BACK] Schema aplicado com sucesso");
}

export async function query(text, params = []) {
    return pool.query(text, params);
}
