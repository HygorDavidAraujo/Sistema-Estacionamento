import express from 'express';
import { createHash } from 'node:crypto';
import { audit, fail } from '../services/financial-domain.js';
import { verifyPassword } from '../services/auth.js';
const tables = ['configuracoes','mensalistas','historico','caixa_turnos','caixa_fechamentos','caixa_movimentos','auditoria','operacoes_financeiras','veiculos_cache'];
const checksum = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
function validate(backup) {
    if (!backup || backup.formato !== 'estacionamento-operacional' || backup.versao !== 1 || !backup.tabelas || backup.checksum !== checksum(backup.tabelas)) fail('Backup inválido, incompleto ou com verificação de integridade incorreta');
    if (Object.keys(backup.tabelas).sort().join() !== [...tables].sort().join()) fail('O backup não contém todas as tabelas exigidas');
    for (const table of tables) {
        const rows = backup.tabelas[table];
        if (!Array.isArray(rows) || rows.length > 100000 || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) fail(`Tabela inválida: ${table}`);
        const keys = rows.map(row => table === 'veiculos_cache' ? row.placa : table === 'operacoes_financeiras' ? row.chave : String(row.id || ''));
        if (keys.some(key => !key) || new Set(keys).size !== keys.length) fail(`Identificadores ausentes ou duplicados: ${table}`);
    }
    if (!backup.tabelas.configuracoes.some(row => row.chave === 'total_vagas')) fail('Configurações obrigatórias ausentes');
    const history = new Set(backup.tabelas.historico.map(row => String(row.id)));
    const monthly = new Set(backup.tabelas.mensalistas.map(row => String(row.id)));
    for (const row of backup.tabelas.caixa_movimentos) {
        if (row.historico_id && !history.has(String(row.historico_id)) || row.mensalista_id && !monthly.has(String(row.mensalista_id))) fail('O backup contém movimentos sem registro de origem');
    }
    return backup.tabelas;
}
export function createBackupRouter({ tx, allow }) {
    const router = express.Router();
    const handle = fn => async (req,res,next) => { try { await fn(req,res); } catch (e) { next(e); } };
    router.get('/backup', allow('administrador'), handle(async (req,res) => {
        const data = await tx(async client => {
            await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            const result = {};
            // Tabelas e identificadores são constantes do servidor, nunca texto do arquivo.
            for (const table of tables) result[table] = (await client.query(`SELECT * FROM ${table} ORDER BY ${table === 'veiculos_cache' ? 'placa' : table === 'operacoes_financeiras' ? 'chave' : 'id'}`)).rows;
            await audit(client,req.user,'backup_export',{ tabelas: tables, registros: Object.values(result).reduce((n,r) => n+r.length,0) });
            return result;
        });
        res.json({ success:true, dados:{ formato:'estacionamento-operacional',versao:1,gerado_em:new Date().toISOString(),tabelas:data,checksum:checksum(data) } });
    }));
    router.post('/restore', allow('administrador'), handle(async (req,res) => {
        if (req.body.confirmacao !== 'RESTAURAR') fail('Confirme a restauração digitando RESTAURAR');
        const data = validate(req.body.backup);
        await tx(async client => {
            const user = (await client.query('SELECT senha_hash FROM usuarios WHERE id=$1 FOR UPDATE',[req.user.id])).rows[0];
            if (!await verifyPassword(req.body.senha,user?.senha_hash)) fail('Senha inválida',403);
            // Valida o tipo e os campos de todas as linhas antes de substituir qualquer registro.
            for (const table of tables) {
                const cols = (await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=\'public\' AND table_name=$1',[table])).rows.map(row => row.column_name);
                if (data[table].some(row => Object.keys(row).some(key => !cols.includes(key)))) fail(`Campos desconhecidos em ${table}`);
                await client.query(`CREATE TEMP TABLE restore_${table} (LIKE ${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP`);
                if (data[table].length) await client.query(`INSERT INTO restore_${table} SELECT * FROM json_populate_recordset(NULL::${table},$1::json)`,[JSON.stringify(data[table])]);
            }
            await client.query(`LOCK TABLE ${tables.join(',')} IN ACCESS EXCLUSIVE MODE`);
            await client.query('DELETE FROM cotacoes_saida');
            for (const table of [...tables].reverse()) await client.query(`DELETE FROM ${table}`);
            for (const table of tables) {
                await client.query(`INSERT INTO ${table} SELECT * FROM restore_${table}`);
                if (!['veiculos_cache','operacoes_financeiras'].includes(table)) await client.query(`SELECT setval(pg_get_serial_sequence('${table}','id'),COALESCE((SELECT MAX(id) FROM ${table}),1),(SELECT COUNT(*)>0 FROM ${table}))`);
            }
            await audit(client,req.user,'backup_restore',{ gerado_em:req.body.backup.gerado_em,checksum:req.body.backup.checksum });
        });
        res.json({success:true,mensagem:'Backup operacional restaurado. Os usuários e suas credenciais foram preservados.'});
    }));
    return router;
}
