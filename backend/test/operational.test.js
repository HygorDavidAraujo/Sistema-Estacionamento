import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {testServer,testDatabase} from './test-database.js';
import {postgresOptions} from '../services/postgres-options.js';
import {decryptBundle,encryptBundle} from '../services/backup-crypto.js';
import {recoverEmptyDatabase} from '../services/full-recovery.js';
const encryption='f1'.repeat(32),cron='cron-test-'.repeat(8),recovery='recovery-test-'.repeat(6);
function memoryStorage(){
    const files=new Map();let corrupted=false,blocked=null,onWrite=null;
    return {files,configured:()=>true,set corrupted(value){corrupted=value;},set blocked(value){blocked=value;},set onWrite(value){onWrite=value;},
        async write(path,bytes){onWrite?.();if(blocked)await blocked;files.set(path,Buffer.from(bytes));return path;},
        async read(path){const bytes=files.get(path);if(!bytes)throw Error('missing');if(corrupted)return Buffer.from('invalid');return Buffer.from(bytes);},
        async remove(path){files.delete(path);}};
}
test('TLS PostgreSQL verifica certificado e hostname mesmo com sslmode=require na URL',()=>{
    const options=postgresOptions({DATABASE_URL:'postgres://test:secret@example.invalid/db?sslmode=require&uselibpqcompat=true',PGSSLMODE:'require'});
    assert.equal(new URL(options.connectionString).searchParams.get('sslmode'),'verify-full');assert.notEqual(new pg.Client(options).connectionParameters.ssl.rejectUnauthorized,false);
});
test('manutenção, cópia externa cifrada, recuperação integral e chave administrativa de uso único',async t=>{
    const storage=memoryStorage();let now=new Date('2026-11-13T12:00:00Z');
    const env={NODE_ENV:'test',AUTH_SETUP_TOKEN:'test-setup-secret',AUTH_RECOVERY_TOKEN:recovery,BACKUP_ENCRYPTION_KEY:encryption,CRON_SECRET:cron};
    const s=await testServer({env,backupStorage:storage,clock:()=>now});t.after(()=>s.close());const admin=s.client(),operator=s.client(),publicClient=s.client();
    const post=(client,path,body={})=>client.request(path,'POST',{operacao_id:randomUUID(),...body});
    await admin.request('/auth/setup','POST',{codigo:'test-setup-secret',login:'admin',nome:'Administrador',senha:'Senha-segura-123'});
    await admin.request('/auth/users','POST',{login:'operador',nome:'Operador',perfil:'operador',senha:'Senha-segura-123'});await operator.request('/auth/login','POST',{login:'operador',senha:'Senha-segura-123'});
    let backupId,bundle,archive,point,paymentId;
    await t.test('prontidão consulta o banco; diagnóstico e manutenção exigem administrador',async()=>{
        assert.equal((await publicClient.request('/ready')).status,200);assert.equal((await operator.request('/operacao/status')).status,403);
        assert.equal((await post(operator,'/operacao/manutencao',{ativo:true,motivo:'Tentativa indevida de manutenção'})).status,403);
        const status=await admin.request('/operacao/status');assert.equal(status.status,200);assert.equal(status.data.dados.backup.configurado,true);
        assert.ok(!JSON.stringify(status.data).includes(encryption));assert.ok(!JSON.stringify(status.data).includes(recovery));
    });
    await t.test('manutenção bloqueia atendimentos, permite consultas e não dá saída no pátio',async()=>{
        assert.equal((await post(operator,'/entrada',{placa:'ABC1D23'})).status,200);
        const shift=(await post(admin,'/caixa/turnos/abrir',{fundo_inicial:100})).data.turno_id;
        const paidEntry=(await post(admin,'/entrada',{placa:'GHI7J89'})).data.entry_id;
        await s.db.query('UPDATE historico SET criado_em=$1 WHERE entry_id=$2',[new Date(now.getTime()-65*60000).toISOString(),paidEntry]);
        const quote=(await post(admin,'/saida/cotacao',{entryId:paidEntry})).data.dados;paymentId=randomUUID();
        assert.equal((await post(admin,'/saida',{cotacao_id:quote.cotacao_id,operacao_id:paymentId,turno_id:shift,pagamentos:[{forma_pagamento:'Pix',valor_pago:7.5}]})).status,200);
        assert.equal((await admin.request(`/operacoes/${paymentId}`)).data.dados.comprovante.total,7.5);assert.equal((await operator.request(`/operacoes/${paymentId}`)).status,403);
        assert.equal((await post(admin,'/operacao/manutencao',{ativo:true,motivo:'Conferência de manutenção em ambiente isolado'})).status,200);
        assert.equal((await post(operator,'/entrada',{placa:'DEF4G56'})).status,503);
        assert.equal((await admin.request('/relatorios/financeiro')).status,200);assert.equal((await admin.request('/historico')).status,200);
        assert.equal((await admin.request('/patio/ativos')).data.dados.length,1);
        await post(admin,'/operacao/manutencao',{ativo:false,motivo:'Conferência concluída, atendimento liberado'});
    });
    await t.test('backup inclui usuários sem sessões, é cifrado, relido e validado antes de ser anunciado',async()=>{
        const result=await post(admin,'/operacao/backups');assert.equal(result.status,200,JSON.stringify(result.data));backupId=result.data.id;
        const row=(await s.db.query('SELECT * FROM backup_execucoes WHERE id=$1',[backupId])).rows[0];assert.equal(row.estado,'concluido');assert.ok(row.verificado_em);
        archive=storage.files.get(row.arquivo);assert.ok(!archive.toString().includes('Senha-segura-123'));assert.ok(!archive.toString().includes('scrypt:'));assert.ok(!archive.toString().includes('ABC1D23'));
        bundle=decryptBundle(archive,encryption);assert.equal(bundle.usuarios.length,2);assert.equal(bundle.operacional.tabelas.sessoes,undefined);assert.equal(bundle.operacional.tabelas.usuarios,undefined);
        assert.equal(bundle.operacional.tabelas.historico.length,2);assert.throws(()=>decryptBundle(archive,'a0'.repeat(32)));
        const changed=JSON.parse(archive);changed.gerado_em='2000-01-01';assert.throws(()=>decryptBundle(Buffer.from(JSON.stringify(changed)),encryption));
        assert.equal(decryptBundle(encryptBundle(bundle,encryption),encryption).operacional.checksum,bundle.operacional.checksum);
    });
    await t.test('falha de leitura não marca cópia como concluída e libera nova tentativa',async()=>{
        storage.corrupted=true;const failed=await post(admin,'/operacao/backups');assert.equal(failed.status,503);
        const rows=(await s.db.query("SELECT * FROM backup_execucoes WHERE estado='falhou'")).rows;assert.equal(rows.length,1);assert.equal(rows[0].verificado_em,null);
        storage.corrupted=false;assert.equal((await post(admin,`/operacao/backups/${rows[0].id}/verificar`)).status,200);assert.equal((await post(admin,'/operacao/backups')).status,200);
    });
    await t.test('duas solicitações simultâneas não executam cópias em paralelo',async()=>{
        let release,started;const entered=new Promise(resolve=>{started=resolve;});storage.onWrite=started;storage.blocked=new Promise(resolve=>{release=resolve;});
        const pending=post(admin,'/operacao/backups');await entered;assert.equal((await post(admin,'/operacao/backups')).status,409);
        release();assert.equal((await pending).status,200);storage.blocked=null;storage.onWrite=null;
    });
    await t.test('agendamento exige segredo, remove somente itens expirados e não duplica o backup diário',async()=>{
        assert.equal((await publicClient.request('/internal/manutencao')).status,401);
        await s.db.query("INSERT INTO cotacoes_saida (chave,historico_id,usuario_id,dados,expira_em) VALUES ('expired',1,1,'{}',NOW()-INTERVAL '1 minute')");
        const headers={Authorization:`Bearer ${cron}`};
        const first=await publicClient.request('/internal/manutencao','GET',undefined,headers);assert.equal(first.status,200,JSON.stringify(first.data));assert.equal(first.data.limpeza.cotacoes,1);
        const again=await publicClient.request('/internal/manutencao','GET',undefined,headers);assert.equal(again.status,200);assert.equal(again.data.backup.repetido,true);assert.equal(again.data.backup.id,first.data.backup.id);
        assert.equal((await s.db.query('SELECT COUNT(*)::int AS n FROM historico')).rows[0].n,2);
    });
    await t.test('restauração exige manutenção, valida antes, guarda ponto de retorno e encerra outras sessões',async()=>{
        const old=bundle.operacional;
        assert.equal((await post(admin,'/restore',{backup:old,confirmacao:'RESTAURAR',senha:'Senha-segura-123'})).status,409);
        assert.equal((await post(admin,'/restore/validar',{backup:old})).status,200);
        await post(operator,'/entrada',{placa:'DEF4G56'});
        await post(admin,'/operacao/manutencao',{ativo:true,motivo:'Restauração segura em base isolada para teste'});
        await s.pg.exec("CREATE FUNCTION reject_restore() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'test'; RETURN NEW; END; $$ LANGUAGE plpgsql; CREATE TRIGGER reject_restore BEFORE INSERT ON historico FOR EACH ROW EXECUTE FUNCTION reject_restore();");
        assert.equal((await post(admin,'/restore',{backup:old,confirmacao:'RESTAURAR',senha:'Senha-segura-123'})).status,500);
        assert.equal((await s.db.query('SELECT COUNT(*)::int AS n FROM historico')).rows[0].n,3);assert.equal((await s.db.query('SELECT COUNT(*)::int AS n FROM operacao_restauracoes')).rows[0].n,0);
        await s.pg.exec('DROP TRIGGER reject_restore ON historico; DROP FUNCTION reject_restore();');
        const restored=await post(admin,'/restore',{backup:old,confirmacao:'RESTAURAR',senha:'Senha-segura-123'});assert.equal(restored.status,200,JSON.stringify(restored.data));point=restored.data.ponto_retorno;
        assert.equal((await admin.request('/operacao/estado')).data.dados.manutencao,true);
        assert.equal((await operator.request('/auth/me')).status,401);
        const safety=(await admin.request(`/operacao/restauracoes/${point}/arquivo`)).data.dados;assert.equal(safety.tabelas.historico.length,3);
        assert.equal((await admin.request('/patio/ativos')).data.dados.length,1);
        await post(admin,'/operacao/manutencao',{ativo:false,motivo:'Valores e pátio conferidos após a restauração'});
    });
    await t.test('recuperação integral funciona em outra base vazia com usuários e sem sessões',async()=>{
        const target=await testDatabase();t.after(()=>target.pg.close());
        const result=await recoverEmptyDatabase(target.db,bundle);assert.equal(result.success,true);
        assert.equal((await target.db.query('SELECT COUNT(*)::int AS n FROM usuarios')).rows[0].n,2);assert.equal((await target.db.query('SELECT COUNT(*)::int AS n FROM sessoes')).rows[0].n,0);
        assert.equal((await target.db.query("SELECT senha_hash FROM usuarios WHERE login='admin'")).rows[0].senha_hash,bundle.usuarios.find(u=>u.login==='admin').senha_hash);
        assert.equal((await target.db.query('SELECT manutencao FROM operacao_estado WHERE id=1')).rows[0].manutencao,true);
        assert.equal(Number((await target.db.query('SELECT SUM(valor_pago) AS total FROM caixa_movimentos')).rows[0].total),7.5);
        assert.equal((await target.db.query('SELECT resposta FROM operacoes_financeiras WHERE chave=$1',[paymentId])).rows[0].resposta.comprovante.total,7.5);
        assert.equal((await target.db.query("SELECT placa FROM historico WHERE entry_id=$1",[bundle.operacional.tabelas.historico[0].entry_id])).rows[0].placa,'ABC1D23');
        await assert.rejects(recoverEmptyDatabase(target.db,bundle),error=>error.status===409);
    });
    await t.test('recuperação administrativa consome o código e revoga a senha/sessões anteriores',async()=>{
        assert.equal((await publicClient.request('/auth/status')).data.recuperacao_disponivel,true);
        assert.equal((await post(publicClient,'/auth/recovery',{login:'admin',codigo:'errado',nova_senha:'Nova-senha-segura-123'})).status,403);
        const reset=await post(publicClient,'/auth/recovery',{login:'admin',codigo:recovery,nova_senha:'Nova-senha-segura-123'});assert.equal(reset.status,200);
        assert.equal((await admin.request('/auth/me')).status,401);
        assert.equal((await admin.request('/auth/login','POST',{login:'admin',senha:'Senha-segura-123'})).status,401);
        assert.equal((await admin.request('/auth/login','POST',{login:'admin',senha:'Nova-senha-segura-123'})).status,200);
        assert.equal((await post(publicClient,'/auth/recovery',{login:'admin',codigo:recovery,nova_senha:'Outra-senha-segura-123'})).status,409);
        assert.equal((await publicClient.request('/auth/status')).data.recuperacao_disponivel,false);
        assert.ok(!JSON.stringify((await admin.request('/auditoria')).data).includes(recovery));
    });
    await t.test('cópia externa admite restauração operacional sem importar senhas antigas',async()=>{
        await post(admin,'/operacao/manutencao',{ativo:true,motivo:'Recuperação pela cópia externa para validação'});
        const result=await post(admin,`/operacao/backups/${backupId}/restaurar`,{confirmacao:'RESTAURAR',senha:'Nova-senha-segura-123'});assert.equal(result.status,200,JSON.stringify(result.data));
        assert.equal((await admin.request('/auth/me')).status,200);
        await post(admin,'/operacao/manutencao',{ativo:false,motivo:'Cópia externa conferida e operação liberada'});
        now=new Date('2027-02-01T12:00:00Z');assert.equal((await post(admin,'/operacao/backups')).status,200);
        assert.ok((await admin.request('/operacao/status')).data.dados.execucoes.filter(r=>r.estado==='concluido'&&r.arquivo).length>=3);
    });
});
