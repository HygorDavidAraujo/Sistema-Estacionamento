import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createDatabaseReadiness, initializationFailure } from '../services/database-readiness.js';
import { createDatabaseInitializer, schemaVersion } from '../services/database-initialization.js';
import { testServer } from './test-database.js';

test('inicialização é preguiçosa, compartilha requisições simultâneas e não repete após sucesso',async()=>{
    let calls=0,release;
    const {ready}=createDatabaseReadiness({initialize:async()=>{calls++;await new Promise(resolve=>{release=resolve;});}});
    assert.equal(calls,0);
    const first=ready(),second=ready();assert.equal(first,second);
    await Promise.resolve();assert.equal(calls,1);release();
    assert.equal(await first,true);assert.equal(await ready(),true);assert.equal(calls,1);
});
test('erro transitório libera nova tentativa, inclusive após throw síncrono',async()=>{
    let clock=0,calls=0;
    const {ready}=createDatabaseReadiness({now:()=>clock,retryDelayMs:1000,initialize:()=>{if(++calls===1)throw Error('Connection terminated due to connection timeout');}});
    assert.equal(await ready(),false);assert.equal(await ready(),false);assert.equal(calls,1);
    clock=1000;assert.equal(await ready(),true);assert.equal(calls,2);
});
test('diagnóstico de preparação não expõe credenciais nem URL de conexão',()=>{
    const result=initializationFailure({code:'ETIMEDOUT',message:'postgres://user:secret@host/db connection timeout'});
    assert.match(result.motivo,/Tempo limite/);assert.ok(!JSON.stringify(result).includes('secret'));
    assert.match(initializationFailure({code:'ENOENT'}).motivo,/Arquivo SQL/);
});
test('API recupera 503 na mesma instância quando o banco volta, sem abrir operações anônimas',async t=>{
    let clock=0,calls=0;
    const system=await testServer({readinessOptions:{now:()=>clock},initialize:async initialize=>{
        if(++calls===1)throw Error('Connection terminated due to connection timeout');await initialize();
    }});t.after(()=>system.close());
    const client=system.client();
    assert.equal(calls,0);assert.equal((await client.request('/health')).status,200);assert.equal(calls,0);
    const failed=await client.request('/api/auth/status');assert.equal(failed.status,503);assert.equal(failed.headers.get('retry-after'),'2');
    assert.equal((await client.request('/auth/status')).status,503);assert.equal(calls,1);
    clock=1001;
    const recovered=await client.request('/auth/status');assert.equal(recovered.status,200);assert.equal(recovered.data.primeiro_acesso,true);assert.equal(calls,2);
    assert.equal((await client.request('/patio/ativos')).status,401);
});
function pgPool(pg){
    return {connect:async()=>({query:async(sql,params=[])=>params.length?pg.query(sql,params):(await pg.exec(sql)).at(-1),release(){}})};
}
const sqlFiles=['migrations/000-compatibility.sql','schema.sql','migrations/001-security.sql','migrations/002-cash-shifts.sql','migrations/003-prepaid-daily.sql','migrations/004-subscriptions-reports.sql','migrations/005-operational-recovery.sql'];
const schemaSql=async()=> (await Promise.all(sqlFiles.map(file=>readFile(new URL(`../${file}`,import.meta.url),'utf8')))).join('\n');
test('migração de banco existente preserva dados, registra versão e evita repetir DDL',async t=>{
    const pg=await PGlite.create();t.after(()=>pg.close());
    await pg.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
    await pg.query("INSERT INTO historico (entry_id,placa) VALUES ('legacy-ticket','ABC1D23')");
    await pg.exec(await readFile(new URL('../migrations/001-security.sql',import.meta.url),'utf8'));
    await pg.exec("CREATE TABLE estacionamento_migracoes (versao TEXT PRIMARY KEY, aplicado_em TIMESTAMPTZ DEFAULT NOW()); INSERT INTO estacionamento_migracoes (versao) VALUES ('001-security'); INSERT INTO caixa_turnos (observacao_abertura) VALUES ('Legado sem caixa vinculado');");
    let loads=0;
    const initialize=createDatabaseInitializer({pool:pgPool(pg),loadSql:async()=>{loads++;return schemaSql();}});
    await initialize();await initialize();assert.equal(loads,1);
    assert.equal((await pg.query("SELECT placa FROM historico WHERE entry_id='legacy-ticket'")).rows[0].placa,'ABC1D23');
    assert.ok((await pg.query('SELECT versao FROM estacionamento_migracoes')).rows.some(row=>row.versao===schemaVersion));
    assert.equal((await pg.query("SELECT estado FROM caixa_turnos WHERE observacao_abertura='Legado sem caixa vinculado'")).rows[0].estado,'legado');
    assert.equal((await pg.query('SELECT COUNT(*)::int AS n FROM usuarios')).rows[0].n,0);
});
test('falha durante migração reverte schema e marcador, permitindo tentativa completa posterior',async t=>{
    const pg=await PGlite.create();t.after(()=>pg.close());
    const bad=createDatabaseInitializer({pool:pgPool(pg),loadSql:async()=>`${await schemaSql()}\nSELECT coluna_inexistente FROM usuarios;`});
    await assert.rejects(bad(),error=>error.code==='42703');
    assert.equal((await pg.query("SELECT to_regclass('public.estacionamento_migracoes') AS tabela")).rows[0].tabela,null);
    const good=createDatabaseInitializer({pool:pgPool(pg),loadSql:schemaSql});await good();
    assert.equal((await pg.query('SELECT versao FROM estacionamento_migracoes')).rows[0].versao,schemaVersion);
});

test('migração de diária preserva caixa aberto e mantém diárias anteriores sem pagamento presumido',async t=>{
    const pg=await PGlite.create();t.after(()=>pg.close());
    for(const file of sqlFiles.filter(file=>!file.includes('003-prepaid-daily')&&!file.includes('004-subscriptions-reports')&&!file.includes('005-operational-recovery')))await pg.exec(await readFile(new URL(`../${file}`,import.meta.url),'utf8'));
    await pg.exec("CREATE TABLE estacionamento_migracoes (versao TEXT PRIMARY KEY, aplicado_em TIMESTAMPTZ DEFAULT NOW()); INSERT INTO estacionamento_migracoes (versao) VALUES ('002-cash-shifts'); INSERT INTO caixa_turnos (estado,operador_id,operador_nome,fundo_inicial) VALUES ('aberto',1,'Responsável anterior',100); INSERT INTO historico (entry_id,placa,diarista) VALUES ('daily-legacy','ABC1D23',true);");
    const initialize=createDatabaseInitializer({pool:pgPool(pg),loadSql:schemaSql});await initialize();
    const shift=(await pg.query('SELECT * FROM caixa_turnos')).rows[0];assert.equal(shift.estado,'aberto');assert.equal(Number(shift.fundo_inicial),100);assert.equal(shift.operador_nome,'Responsável anterior');
    const entry=(await pg.query('SELECT * FROM historico')).rows[0];assert.equal(entry.diaria_retirada_em,null);assert.equal(entry.diaria_valor_pago,null);assert.equal(entry.diarista,true);
});

test('migração de contratos preserva validade quitada sem gerar dívida ou recibo retroativo',async t=>{
    const pg=await PGlite.create();t.after(()=>pg.close());
    for(const file of sqlFiles.filter(file=>!file.includes('004-subscriptions-reports')&&!file.includes('005-operational-recovery')))await pg.exec(await readFile(new URL(`../${file}`,import.meta.url),'utf8'));
    await pg.exec("CREATE TABLE estacionamento_migracoes (versao TEXT PRIMARY KEY, aplicado_em TIMESTAMPTZ DEFAULT NOW()); INSERT INTO estacionamento_migracoes (versao) VALUES ('003-prepaid-daily'); INSERT INTO mensalistas (placa,nome,vencimento,criado_em) VALUES ('ABC1D23','Cliente anterior','2027-01-31','2026-11-01T12:00:00Z');");
    const initialize=createDatabaseInitializer({pool:pgPool(pg),loadSql:schemaSql});await initialize();
    const contract=(await pg.query("SELECT TO_CHAR(pago_ate,'YYYY-MM-DD') AS pago_ate,TO_CHAR(inicio,'YYYY-MM-DD') AS inicio FROM mensalista_contratos")).rows[0];
    assert.equal(contract.pago_ate,'2027-01-31');assert.equal(contract.inicio,'2026-11-01');assert.equal((await pg.query('SELECT COUNT(*)::int AS n FROM mensalista_cobrancas')).rows[0].n,0);
    assert.equal((await pg.query('SELECT COUNT(*)::int AS n FROM caixa_movimentos')).rows[0].n,0);assert.equal((await pg.query('SELECT placa FROM mensalista_veiculos')).rows[0].placa,'ABC1D23');
});
