export const schemaVersion = '002-cash-shifts';
const migrationLock = 743221905;

export function createDatabaseInitializer({ pool, loadSql, onApplied = () => {} }) {
    return async function initialize() {
        const client = await pool.connect();
        let transaction = false;
        try {
            // Instâncias novas só consultam a versão; não repetem dezenas de DDLs.
            try {
                const result = await client.query('SELECT versao FROM public.estacionamento_migracoes WHERE versao=$1', [schemaVersion]);
                if (result.rows.length) return;
            } catch (error) {
                if (error.code !== '42P01') throw error;
            }
            await client.query('BEGIN');
            transaction = true;
            await client.query("SET LOCAL lock_timeout = '10s'");
            await client.query('SELECT pg_advisory_xact_lock($1)', [migrationLock]);
            await client.query(`CREATE TABLE IF NOT EXISTS public.estacionamento_migracoes (
                versao TEXT PRIMARY KEY, aplicado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )`);
            const version = await client.query('SELECT versao FROM public.estacionamento_migracoes WHERE versao=$1', [schemaVersion]);
            if (!version.rows.length) {
                const sql = await loadSql();
                await client.query(sql);
                await client.query('INSERT INTO public.estacionamento_migracoes (versao) VALUES ($1)', [schemaVersion]);
            }
            await client.query('COMMIT');
            transaction = false;
            onApplied();
        } catch (error) {
            if (transaction) await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    };
}
