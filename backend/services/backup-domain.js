import {createHash} from 'node:crypto';
import {fail} from './financial-domain.js';
import {seedLegacySubscriptions} from './subscription-domain.js';
import {seedPeriodSettings} from './period-domain.js';
const oldTables = ['configuracoes','mensalistas','historico','caixa_turnos','caixa_fechamentos','caixa_movimentos','auditoria','operacoes_financeiras','veiculos_cache'];
const v2Tables = [...oldTables,'caixa_ajustes','caixa_conferencias','caixa_acoes'];
const subscriptionTables=['mensalista_contratos','mensalista_veiculos','mensalista_cobrancas'];
export const tables=['configuracoes','mensalistas',...subscriptionTables,...v2Tables.filter(t=>!['configuracoes','mensalistas'].includes(t))];
const keyColumn=table=>table==='veiculos_cache'?'placa':['operacoes_financeiras','caixa_acoes'].includes(table)?'chave':'id';
const checksum = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
export function validateBackup(backup) {
    if (!backup || backup.formato !== 'estacionamento-operacional' || ![1,2,3].includes(backup.versao) || !backup.tabelas || backup.checksum !== checksum(backup.tabelas)) fail('Backup inválido, incompleto ou com verificação de integridade incorreta');
    const expected=backup.versao===1?oldTables:backup.versao===2?v2Tables:tables;
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
    if(backup.versao<3){for(const table of subscriptionTables)result[table]=[];result.operacoes_financeiras=result.operacoes_financeiras.map(row=>({...row,cobranca_id:null}));}
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
    const contracts=new Map(result.mensalista_contratos.map(row=>[String(row.id),row]));
    const invoices=new Set(result.mensalista_cobrancas.map(row=>String(row.id)));
    for(const table of ['mensalista_contratos','mensalista_veiculos'])for(const row of result[table])if(!monthly.has(String(row.mensalista_id)))fail('Contrato ou veículo sem cliente de origem');
    for(const row of result.mensalista_cobrancas)if(!contracts.has(String(row.contrato_id)))fail('Cobrança sem contrato de origem');
    for(const row of result.operacoes_financeiras)if(row.cobranca_id&&!invoices.has(String(row.cobranca_id)))fail('Recebimento sem cobrança de origem');
    return result;
}
export async function captureOperational(client,now=new Date()){
    const data={};for(const table of tables)data[table]=(await client.query(`SELECT * FROM ${table} ORDER BY ${keyColumn(table)}`)).rows;
    return {formato:'estacionamento-operacional',versao:3,gerado_em:now.toISOString(),tabelas:data,checksum:checksum(data)};
}
export async function prepareOperational(client,backup){
    const data=validateBackup(backup);
    for(const table of tables){
        const columns=(await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[table])).rows.map(row=>row.column_name);
        if(data[table].some(row=>Object.keys(row).some(key=>!columns.includes(key))))fail(`Campos desconhecidos em ${table}`);
        await client.query(`CREATE TEMP TABLE restore_${table} (LIKE ${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP`);
        if(data[table].length)await client.query(`INSERT INTO restore_${table} SELECT * FROM json_populate_recordset(NULL::${table},$1::json)`,[JSON.stringify(data[table])]);
    }
}
export async function applyOperational(client,backup){
    await prepareOperational(client,backup);
    await client.query(`LOCK TABLE ${tables.join(',')} IN ACCESS EXCLUSIVE MODE`);
    await client.query('DELETE FROM cotacoes_saida');
    for(const table of [...tables].reverse())await client.query(`DELETE FROM ${table}`);
    for(const table of tables){
        await client.query(`INSERT INTO ${table} SELECT * FROM restore_${table}`);
        if(keyColumn(table)==='id')await client.query(`SELECT setval(pg_get_serial_sequence('${table}','id'),COALESCE((SELECT MAX(id) FROM ${table}),1),(SELECT COUNT(*)>0 FROM ${table}))`);
    }
    if(backup.versao<3)await seedLegacySubscriptions(client);
    await seedPeriodSettings(client);
}
export function recordCount(backup){return Object.values(backup.tabelas).reduce((n,rows)=>n+rows.length,0);}
export const operationLock=743221910;
