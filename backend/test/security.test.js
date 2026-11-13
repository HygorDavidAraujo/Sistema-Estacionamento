import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { testServer } from './test-database.js';
import { cents,addMonths } from '../services/financial-domain.js';

test('valores monetários rejeitam negativos, não finitos e fração de centavo; datas respeitam fim de mês', () => {
    for (const value of [-1,NaN,Infinity,1.001,'-1','1e3',null]) assert.throws(()=>cents(value));
    assert.equal(cents(19.90),1990);
    assert.equal(addMonths('2027-01-31',1),'2027-02-28');
    assert.equal(addMonths('2028-01-31',1),'2028-02-29');
});
test('acesso, permissões, cobranças, transações e restore com PostgreSQL isolado', async t => {
    const system=await testServer(); t.after(()=>system.close());
    const admin=system.client(), operator=system.client(), publicClient=system.client();
    let turno;
    await t.test('nega segredo compartilhado e acesso anônimo; bootstrap é único', async()=>{
        assert.equal((await publicClient.request('/patio/ativos')).status,401);
        assert.equal((await publicClient.request('/patio/ativos','GET',undefined,{'x-admin-token':'qualquer'})).status,401);
        assert.equal((await admin.request('/auth/setup','POST',{codigo:'errado',login:'admin',nome:'Administrador',senha:'Senha-segura-123'})).status,403);
        const result=await admin.request('/auth/setup','POST',{codigo:'test-setup-secret',login:'admin',nome:'Administrador',senha:'Senha-segura-123'});
        assert.equal(result.status,200); assert.match(result.headers.get('set-cookie'),/HttpOnly/);
        assert.equal((await publicClient.request('/auth/setup','POST',{codigo:'test-setup-secret',login:'outro',nome:'Outro',senha:'Senha-segura-123'})).status,409);
        const stored=(await system.db.query('SELECT senha_hash FROM usuarios')).rows[0].senha_hash;
        assert.match(stored,/^scrypt:/); assert.ok(!stored.includes('Senha-segura'));
    });
    await t.test('CSRF e origens externas bloqueados; operador não altera administração',async()=>{
        const created=await admin.request('/auth/users','POST',{login:'operador',nome:'Operador',perfil:'operador',senha:'Senha-operador-123'}); assert.equal(created.status,201);
        assert.equal((await operator.request('/auth/login','POST',{login:'operador',senha:'Senha-operador-123'})).status,200);
        assert.equal((await operator.request('/configuracoes','PUT',{valor_hora_inicial:'0'})).status,403);
        assert.equal((await operator.request('/CONFIGURACOES/','PUT',{valor_hora_inicial:'0'})).status,403);
        assert.equal((await operator.request('/backup')).status,403);
        assert.equal((await operator.request('/caixa/fechamento','POST',{})).status,400);
        assert.equal((await admin.request('/configuracoes','PUT',{valor_hora_inicial:'1'},{'x-csrf-token':'errado'})).status,403);
        assert.equal((await admin.request('/entrada','POST',{placa:'ABC1D23'},{Origin:'https://externo.invalid'})).status,403);
        const opened=await operator.request('/caixa/turnos/abrir','POST',{operacao_id:randomUUID(),fundo_inicial:0});assert.equal(opened.status,200);turno=opened.data.turno_id;
    });
    let ticket,quote,payment;
    await t.test('mensalista não quitado é recusado; entrada guarda tarifa e identidade do operador',async()=>{
        assert.equal((await operator.request('/entrada','POST',{placa:'ABC1D23',mensalista:true})).status,409);
        const result=await operator.request('/entrada','POST',{placa:'ABC1D23',marca:'Marca',modelo:'Modelo'});
        assert.equal(result.status,200); ticket=result.data.entry_id;
        assert.ok(result.data.comprovante.tarifa); assert.equal(result.data.comprovante.operador,'Operador');
        assert.equal((await operator.request('/entrada','POST',{placa:'ABC1D23'})).status,409);
        await system.db.query("UPDATE historico SET criado_em=NOW()-INTERVAL '65 minutes' WHERE entry_id=$1",[ticket]);
    });
    await t.test('cotação ignora valores do cliente e saída rejeita pagamento insuficiente/negativo',async()=>{
        const result=await operator.request('/saida/cotacao','POST',{entryId:ticket}); assert.equal(result.status,200); quote=result.data.dados;
        assert.equal(quote.valor,7.5);
        assert.equal((await operator.request('/saida','POST',{entryId:ticket,valor_pago:0})).status,400);
        assert.equal((await operator.request('/saida','POST',{turno_id:turno,cotacao_id:quote.cotacao_id,operacao_id:randomUUID(),pagamentos:[]})).status,409);
        assert.equal((await operator.request('/saida','POST',{turno_id:turno,cotacao_id:quote.cotacao_id,operacao_id:randomUUID(),pagamentos:[{forma_pagamento:'Pix',valor_pago:-1}]})).status,400);
    });
    await t.test('falha na segunda parcela desfaz baixa, pagamento e auditoria da operação',async()=>{
        await system.pg.exec(`CREATE FUNCTION reject_cash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.forma_pagamento='Dinheiro' THEN RAISE EXCEPTION 'falha de teste'; END IF; RETURN NEW; END; $$;
            CREATE TRIGGER fail_second BEFORE INSERT ON caixa_movimentos FOR EACH ROW EXECUTE FUNCTION reject_cash();`);
        const result=await operator.request('/saida','POST',{turno_id:turno,cotacao_id:quote.cotacao_id,operacao_id:randomUUID(),pagamentos:[{forma_pagamento:'Pix',valor_pago:5},{forma_pagamento:'Dinheiro',valor_pago:2.5}]});
        assert.equal(result.status,500);
        assert.equal((await system.db.query('SELECT status FROM historico WHERE entry_id=$1',[ticket])).rows[0].status,'ativo');
        assert.equal((await system.db.query('SELECT COUNT(*)::int AS n FROM caixa_movimentos')).rows[0].n,0);
        await system.pg.exec('DROP TRIGGER fail_second ON caixa_movimentos; DROP FUNCTION reject_cash();');
    });
    await t.test('pagamento correto é atômico e reenvio retorna mesmo recibo sem duplicar',async()=>{
        payment={turno_id:turno,cotacao_id:quote.cotacao_id,operacao_id:randomUUID(),pagamentos:[{forma_pagamento:'Pix',valor_pago:5},{forma_pagamento:'Dinheiro',valor_pago:2.5}]};
        const first=await operator.request('/saida','POST',payment), second=await operator.request('/saida','POST',payment);
        assert.equal(first.status,200); assert.equal(second.status,200); assert.deepEqual(first.data,second.data);
        assert.equal(first.data.comprovante.total,7.5);
        assert.equal((await system.db.query('SELECT COUNT(*)::int AS n FROM caixa_movimentos')).rows[0].n,2);
        assert.equal((await operator.request('/saida','POST',{...payment,pagamentos:[{forma_pagamento:'Pix',valor_pago:7.5}]})).status,409);
        const original=await operator.request(`/comprovantes/entrada/${ticket}`); assert.equal(original.data.dados.tarifa.inicial,500);
    });
    await t.test('mensalidade usa preço do servidor, acrescenta 30 dias à validade quitada e evita duplicidade',async()=>{
        await system.db.query("INSERT INTO mensalistas (placa,nome,vencimento) VALUES ('DEF4G56','Cliente','2099-01-31')");
        const id=(await system.db.query("SELECT id FROM mensalistas WHERE placa='DEF4G56'")).rows[0].id;
        const quote12=(await operator.request('/mensalistas/'+id+'/cotacao','POST',{meses:12})).data.dados;
        const quote1=(await operator.request('/mensalistas/'+id+'/cotacao','POST',{meses:1})).data.dados;
        const invalid=await operator.request('/mensalistas/pagamentos','POST',{turno_id:turno,mensalista_id:id,meses:12,revisao:quote12.revisao,periodo_previsto:quote12.fim_periodo,operacao_id:randomUUID(),pagamentos:[{forma_pagamento:'Pix',valor_pago:0.01}]}); assert.equal(invalid.status,409);
        const body={turno_id:turno,mensalista_id:id,meses:1,revisao:quote1.revisao,periodo_previsto:quote1.fim_periodo,operacao_id:randomUUID(),pagamentos:[{forma_pagamento:'Pix',valor_pago:300}]};
        const a=await operator.request('/mensalistas/pagamentos','POST',body), b=await operator.request('/mensalistas/pagamentos','POST',body);
        assert.equal(a.status,200); assert.equal(a.data.novo_vencimento,'2099-03-02'); assert.deepEqual(a.data,b.data);
        assert.equal(a.data.comprovante.meses,1);
    });
    await t.test('backup completo; restore vazio/inválido ou sem senha não altera dados; recuperação preserva sequências',async()=>{
        assert.equal((await admin.request('/restore','POST',{})).status,400);
        const exported=await admin.request('/backup'); assert.equal(exported.status,200);
        const backup=exported.data.dados;
        for(const table of ['caixa_turnos','caixa_fechamentos','auditoria','operacoes_financeiras']) assert.ok(Array.isArray(backup.tabelas[table]));
        assert.equal(backup.tabelas.usuarios,undefined);
        assert.equal((await admin.request('/restore','POST',{backup,confirmacao:'RESTAURAR',senha:'errada'})).status,403);
        const bad=structuredClone(backup); bad.tabelas.historico=[];
        assert.equal((await admin.request('/restore','POST',{backup:bad,confirmacao:'RESTAURAR',senha:'Senha-segura-123'})).status,400);
        await admin.request('/operacao/manutencao','POST',{ativo:true,motivo:'Restauração de teste em banco isolado'});
        const restored=await admin.request('/restore','POST',{backup,confirmacao:'RESTAURAR',senha:'Senha-segura-123'});
        assert.equal(restored.status,200,JSON.stringify(restored.data));
        await admin.request('/operacao/manutencao','POST',{ativo:false,motivo:'Conferência de teste concluída com sucesso'});
        await operator.request('/auth/login','POST',{login:'operador',senha:'Senha-operador-123'});
        assert.equal((await operator.request('/entrada','POST',{placa:'GHI7J89'})).status,200);
    });
    await t.test('limita falhas repetidas sem bloquear sucessivos logins corretos de funcionários',async()=>{
        const guest=system.client();
        for(let i=0;i<15;i++)assert.equal((await guest.request('/auth/login','POST',{login:'inexistente',senha:'errada'})).status,401);
        assert.equal((await guest.request('/auth/login','POST',{login:'inexistente',senha:'errada'})).status,429);
        for(let i=0;i<17;i++)assert.equal((await guest.request('/auth/login','POST',{login:'admin',senha:'Senha-segura-123'})).status,200);
    });
    await t.test('desativação revoga sessões e último administrador não pode ser removido',async()=>{
        const users=(await admin.request('/auth/users')).data.dados;
        const op=users.find(u=>u.login==='operador'), owner=users.find(u=>u.login==='admin');
        assert.equal((await admin.request(`/auth/users/${owner.id}`,'PATCH',{ativo:false})).status,409);
        assert.equal((await admin.request(`/auth/users/${op.id}`,'PATCH',{ativo:false})).status,409);
        const summary=(await operator.request(`/caixa/turnos/${turno}/resumo`)).data.dados.resumo;
        assert.equal((await operator.request('/caixa/turnos/fechar','POST',{operacao_id:randomUUID(),turno_id:turno,revisao:summary.revisao,contagem:{dinheiro:summary.saldo_esperado,credito:summary.total_credito,debito:summary.total_debito,pix:summary.total_pix}})).status,200);
        assert.equal((await admin.request(`/auth/users/${op.id}`,'PATCH',{ativo:false})).status,200);
        assert.equal((await operator.request('/patio/ativos')).status,401);
        assert.equal((await admin.request('/auth/logout','POST',{})).status,200);
        assert.equal((await admin.request('/patio/ativos')).status,401);
    });
});
