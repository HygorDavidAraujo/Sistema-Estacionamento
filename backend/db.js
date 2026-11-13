import pg from "pg";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { attachDatabasePool } from '@vercel/functions';
import { createDatabaseInitializer } from './services/database-initialization.js';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.warn("[BACK] DATABASE_URL não definido. Configure no ambiente para conectar ao Postgres.");
}

function timeout(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value >= 1000 && value <= 60000 ? value : fallback;
}

const pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: timeout('PG_CONNECTION_TIMEOUT_MS', 15000),
    idleTimeoutMillis: 10000,
    query_timeout: timeout('PG_QUERY_TIMEOUT_MS', 15000),
    keepAlive: true,
    allowExitOnIdle: true,
    ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined
});
if (process.env.VERCEL) attachDatabasePool(pool);
pool.on('error', error => console.error('[BACK] Falha de conexão ociosa:', error.code || 'DATABASE_CONNECTION_ERROR'));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const initDb = createDatabaseInitializer({
    pool,
    loadSql: async () => (await Promise.all([
        'migrations/000-compatibility.sql',
        'schema.sql',
        'migrations/001-security.sql',
        'migrations/002-cash-shifts.sql',
        'migrations/003-prepaid-daily.sql','migrations/004-subscriptions-reports.sql'
    ].map(file => fs.readFile(resolve(__dirname, file), 'utf8')))).join('\n'),
    onApplied: () => console.log('[BACK] Schema aplicado com sucesso')
});
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
