import express from 'express';
import { createHash } from 'node:crypto';
import { audit, fail } from '../services/financial-domain.js';
import { verifyPassword } from '../services/auth.js';
const oldTables = ['configuracoes','mensalistas','historico','caixa_turnos','caixa_fechamentos','caixa_movimentos','auditoria','operacoes_financeiras','veiculos_cache'];
const tables = [...oldTables,'caixa_ajustes','caixa_conferencias','caixa_acoes'];
const keyColumn=table=>table==='veiculos_cache'?'placa':['operacoes_financeiras','caixa_acoes'].includes(table)?'chave':'id';
const checksum = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
function validate(backup) {
    if (!backup || backup.formato !== 'estacionamento-operacional' || ![1,2].includes(backup.versao) || !backup.tabelas || backup.checksum !== checksum(backup.tabelas)) fail('Backup inválido, incompleto ou com verificação de integridade incorreta');
    const expected=backup.versao===1?oldTables:tables;
    if (Object.keys(backup.tabelas).sort().join() !== [...expected].sort().join()) fail('O backup não contém todas as tabelas exigidas');
    for (const table of expected) {
        const rows = backup.tabelas[table];
        if (!Array.isArray(rows) || rows.length > 100000 || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) fail(`Tabela inválida: ${table}`);
        const keys = rows.map(row => String(row[keyColumn(table)] || ''));
        if (keys.some(key => !key) || new Set(keys).size !== keys.length) fail(`Identificadores ausentes ou duplicados: ${table}`);
    }
    if (!backup.tabelas.configuracoes.some(row => row.chave === 'total_vagas')) fail('Configurações obrigatórias ausentes');
    const history = new Set(backup.tabelas.historico.map(row => String(row.id)));
    const monthly = new Set(backup.tabelas.mensalistas.map(row => String(row.id)));
    for (const row of backup.tabelas.caixa_movimentos) {
        if (row.historico_id && !history.has(String(row.historico_id)) || row.mensalista_id && !monthly.has(String(row.mensalista_id))) fail('O backup contém movimentos sem registro de origem');
    }
    const result=structuredClone(backup.tabelas);
    if(backup.versao===1){
        for(const table of ['caixa_ajustes','caixa_conferencias','caixa_acoes'])result[table]=[];
        result.caixa_turnos=result.caixa_turnos.map(row=>({...row,estado:'legado',operador_id:null,operador_nome:null,fundo_inicial:0,revisao:0,ultima_conferencia_id:null}));
        result.caixa_movimentos=result.caixa_movimentos.map(row=>({...row,turno_id:null,operador_id:null,operador_nome:null}));
        result.operacoes_financeiras=result.operacoes_financeiras.map(row=>({...row,turno_id:null}));
    }
    const shifts=new Map(result.caixa_turnos.map(row=>[String(row.id),row]));
    const conferences=new Map(result.caixa_conferencias.map(row=>[String(row.id),row]));
    if(result.caixa_turnos.filter(row=>row.estado==='aberto').length>1)fail('O backup contém mais de um caixa aberto');
    for(const table of ['caixa_movimentos','operacoes_financeiras','caixa_ajustes','caixa_conferencias','caixa_acoes']){
        for(const row of result[table])if(row.turno_id && !shifts.has(String(row.turno_id)))fail('Há movimentos ou conferências sem turno de origem');
    }
    for(const row of result.caixa_turnos)if(row.ultima_conferencia_id && String(conferences.get(String(row.ultima_conferencia_id))?.turno_id)!==String(row.id))fail('Conferência final do turno inválida');
    return result;
}
export function createBackupRouter({ tx, allow }) {
    const router = express.Router();
    const handle = fn => async (req,res,next) => { try { await fn(req,res); } catch (e) { next(e); } };
    router.get('/backup', allow('administrador'), handle(async (req,res) => {
        const data = await tx(async client => {
            await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            const result = {};
            // Tabelas e identificadores são constantes do servidor, nunca texto do arquivo.
            for (const table of tables) result[table] = (await client.query(`SELECT * FROM ${table} ORDER BY ${keyColumn(table)}`)).rows;
            await audit(client,req.user,'backup_export',{ tabelas: tables, registros: Object.values(result).reduce((n,r) => n+r.length,0) });
            return result;
        });
        res.json({ success:true, dados:{ formato:'estacionamento-operacional',versao:2,gerado_em:new Date().toISOString(),tabelas:data,checksum:checksum(data) } });
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
                if (keyColumn(table)==='id') await client.query(`SELECT setval(pg_get_serial_sequence('${table}','id'),COALESCE((SELECT MAX(id) FROM ${table}),1),(SELECT COUNT(*)>0 FROM ${table}))`);
            }
            await audit(client,req.user,'backup_restore',{ gerado_em:req.body.backup.gerado_em,checksum:req.body.backup.checksum });
        });
        res.json({success:true,mensagem:'Backup operacional restaurado. Os usuários e suas credenciais foram preservados.'});
    }));
    return router;
}
