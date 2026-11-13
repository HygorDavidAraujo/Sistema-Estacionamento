import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {testServer} from './test-database.js';
import {addPaidPeriods} from '../services/subscription-domain.js';

test('mensalidade usa períodos exatos de 30 dias, inclusive fevereiro e ano bissexto',()=>{
    assert.equal(addPaidPeriods('2026-01-31',1),'2026-03-02');
    assert.equal(addPaidPeriods('2028-01-31',1),'2028-03-01');
    assert.equal(addPaidPeriods('2026-11-13',2),'2027-01-12');
});
test('contratos pré-pagos, veículos, cobrança parcial, avisos e backup',async t=>{
    let now=new Date('2026-11-13T12:00:00Z');const system=await testServer({clock:()=>now});t.after(()=>system.close());const admin=system.client(),operator=system.client();
    const post=(c,path,body={})=>c.request(path,'POST',{operacao_id:randomUUID(),...body});
    await admin.request('/auth/setup','POST',{codigo:'test-setup-secret',login:'admin',nome:'Administrador',senha:'Senha-segura-123'});
    await admin.request('/auth/users','POST',{login:'operador',nome:'Operador',perfil:'operador',senha:'Senha-segura-123'});await operator.request('/auth/login','POST',{login:'operador',senha:'Senha-segura-123'});
    const shift=(await post(operator,'/caixa/turnos/abrir',{fundo_inicial:0})).data.turno_id;
    const body={placa:'ABC1D23',nome:'Cliente de contrato',cpf:'529.982.247-25',telefone:'(11) 99999-9999',valor_mensal:'300.00',plano:'Plano família',inicio:'2026-11-13',veiculos:['DEF4G56'],limite_simultaneo:1};
    let id,partial,original,quote;
    const preview=async()=>{const r=await post(operator,`/mensalistas/${id}/cotacao`,{});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.dados;};
    const receive=async(q,amount,key=randomUUID())=>post(operator,'/mensalistas/pagamentos',{mensalista_id:id,meses:q.meses,revisao:q.revisao,cobranca_id:q.cobranca_id,periodo_previsto:q.fim_periodo,turno_id:shift,operacao_id:key,valor_recebido:amount,pagamentos:[{forma_pagamento:'Pix',valor_pago:amount}]});
    await t.test('cadastro validado não concede benefício nem aceita vencimento livre',async()=>{
        assert.equal((await post(operator,'/mensalistas',body)).status,403);
        assert.equal((await post(admin,'/mensalistas',{...body,cpf:'12345678900'})).status,400);
        assert.equal((await post(admin,'/mensalistas',{...body,vencimento:'2099-01-01'})).status,400);
        const created=await post(admin,'/mensalistas',body);assert.equal(created.status,200,JSON.stringify(created.data));id=created.data.dados.id;
        assert.equal((await post(admin,'/mensalistas',body)).status,409);
        assert.equal((await post(operator,'/entrada',{placa:'DEF4G56',mensalista:true})).status,409);
        const row=(await admin.request('/mensalistas/DEF4G56')).data.dados;assert.equal(row.situacao,'sem_pagamento');assert.equal(row.cpf,'52998224725');
        const swapped=await admin.request(`/mensalistas/${id}`,'PUT',{...body,placa:'DEF4G56',veiculos:['ABC1D23'],motivo:'Alteração autorizada da placa principal'});assert.equal(swapped.status,200);assert.equal(swapped.data.dados.placa,'DEF4G56');
        assert.equal((await admin.request(`/mensalistas/${id}`,'PUT',{...body,motivo:'Restabelecimento da placa principal original'})).status,200);
        assert.equal((await post(admin,'/mensalistas',{...body,placa:'GHI7J89'})).status,409);
    });
    await t.test('cobrança é única; parcial não libera acesso, saldo fica registrado e reenvio não duplica',async()=>{
        quote=await preview();assert.equal(quote.fim_periodo,'2026-12-13');
        const key=randomUUID();const generated=await post(operator,`/mensalistas/${id}/cobrancas`,{meses:1,revisao:quote.revisao,operacao_id:key});assert.equal(generated.status,200);
        assert.deepEqual((await post(operator,`/mensalistas/${id}/cobrancas`,{meses:1,revisao:quote.revisao,operacao_id:key})).data,generated.data);
        quote=await preview();
        await system.pg.exec("CREATE FUNCTION reject_monthly() RETURNS trigger AS $$ BEGIN IF NEW.origem='mensalidade' AND NEW.forma_pagamento='Dinheiro' THEN RAISE EXCEPTION 'test'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql; CREATE TRIGGER reject_monthly BEFORE INSERT ON caixa_movimentos FOR EACH ROW EXECUTE FUNCTION reject_monthly();");
        const failed=await post(operator,'/mensalistas/pagamentos',{mensalista_id:id,meses:1,revisao:quote.revisao,cobranca_id:quote.cobranca_id,periodo_previsto:quote.fim_periodo,turno_id:shift,valor_recebido:100,pagamentos:[{forma_pagamento:'Pix',valor_pago:50},{forma_pagamento:'Dinheiro',valor_pago:50}]});assert.equal(failed.status,500);
        assert.equal(Number((await system.db.query('SELECT pago FROM mensalista_cobrancas WHERE id=$1',[quote.cobranca_id])).rows[0].pago),0);
        await system.pg.exec('DROP TRIGGER reject_monthly ON caixa_movimentos; DROP FUNCTION reject_monthly();');
        const paymentKey=randomUUID();partial=await receive(quote,100,paymentKey);assert.equal(partial.status,200,JSON.stringify(partial.data));original=partial.data.comprovante;
        assert.equal(original.pagamento_parcial,true);assert.equal(original.novo_vencimento,null);assert.equal(original.saldo_pendente,200);
        assert.deepEqual((await receive(quote,100,paymentKey)).data,partial.data);
        assert.equal((await receive(quote,100)).status,409);
        assert.equal((await post(operator,'/entrada',{placa:'ABC1D23',mensalista:true})).status,409);
        const detail=(await admin.request(`/mensalistas/${id}/financeiro`)).data.dados;assert.equal(detail.cobrancas.length,1);assert.equal(Number(detail.cobrancas[0].pago),100);
        assert.equal((await post(admin,`/mensalistas/${id}/cobrancas/${detail.cobrancas[0].id}/cancelar`,{motivo:'Cliente solicitou cancelamento do plano'})).status,409);
    });
    await t.test('quitação inicia os 30 dias na data efetiva e mantém o preço da cobrança emitida',async()=>{
        assert.equal((await admin.request(`/mensalistas/${id}`,'PUT',{...body,valor_mensal:350,motivo:'Reajuste do plano para o próximo período'})).status,200);
        now=new Date('2026-11-20T12:00:00Z');quote=await preview();assert.equal(quote.saldo,200);assert.equal(quote.valor_mensal,300);assert.equal(quote.fim_periodo,'2026-12-20');
        const paid=await receive(quote,200);assert.equal(paid.status,200);assert.equal(paid.data.novo_vencimento,'2026-12-20');assert.equal(paid.data.comprovante.dias,30);
        const next=await preview();assert.equal(next.valor_mensal,350);assert.equal(next.fim_periodo,'2027-01-19');
        assert.equal((await post(operator,'/entrada',{placa:'DEF4G56',mensalista:true})).status,200);
        assert.equal((await post(operator,'/entrada',{placa:'ABC1D23',mensalista:true})).status,409);
        assert.equal((await admin.request(`/mensalistas/${id}`,'PUT',{...body,veiculos:[],motivo:'Remoção de placa solicitada pelo titular'})).status,409);
        assert.equal((await post(admin,`/mensalistas/${id}/regularizar-validade`,{pago_ate:'2099-01-01',motivo:'Regularização de validade solicitada'})).status,409);
        const history=(await operator.request(`/mensalistas/${id}/pagamentos`)).data;assert.equal(history.recebimentos.length,2);assert.equal(history.dados.length,0);
        const cash=(await operator.request('/caixa/dashboard')).data.dados;assert.equal(cash.total_recebido,300);assert.equal(cash.total_transacoes,2);
    });
    await t.test('avisos distinguem dois dias antes, dia de vencimento e vencido; renovação atrasada não cobra tempo sem uso',async()=>{
        for(const [day,state]of [['17','em_dia'],['18','a_vencer'],['19','a_vencer'],['20','vence_hoje'],['21','vencido']]){
            now=new Date(`2026-12-${day}T12:00:00Z`);const row=(await admin.request('/mensalistas/ABC1D23')).data.dados;assert.equal(row.situacao,state);
            const notices=(await admin.request('/mensalistas/avisos')).data.dados;assert.equal(notices.some(r=>String(r.id)===String(id)),state!=='em_dia');
        }
        const next=await preview();assert.equal(next.total,350);assert.equal(next.inicio_periodo,'2026-12-21');assert.equal(next.fim_periodo,'2027-01-20');
        const vehicle=(await system.db.query("SELECT entry_id FROM historico WHERE placa='DEF4G56' AND status='ativo'")).rows[0].entry_id;
        const decision=(await post(operator,'/saida/cotacao',{entryId:vehicle})).data.dados;assert.equal(decision.mensalista_vencido,true);assert.equal(decision.cotacao_id,undefined);
        const late=(await post(operator,'/saida/cotacao',{entryId:vehicle,continuar_avulso:true})).data.dados;assert.equal(late.valor,25);
        const exit=await post(operator,'/saida',{cotacao_id:late.cotacao_id,turno_id:shift,pagamentos:[{forma_pagamento:'Pix',valor_pago:25}]});assert.equal(exit.status,200);assert.equal(exit.data.comprovante.confirmacao_avulso,true);
        const suspended=await admin.request(`/mensalistas/${id}/status`,'PATCH',{estado:'suspenso',motivo:'Suspensão solicitada pelo titular do plano'});assert.equal(suspended.status,200);
        quote=await preview();assert.equal((await receive(quote,350)).status,200);
        assert.equal((await post(operator,'/entrada',{placa:'ABC1D23',mensalista:true})).status,409);
        assert.equal((await admin.request(`/mensalistas/${id}/status`,'PATCH',{estado:'ativo',motivo:'Reativação autorizada após conferência'})).status,200);
    });
    await t.test('backup versão 3 mantém vínculos, cobranças e recibos; versão 2 preserva validades sem inventar dívida',async()=>{
        const backup=(await admin.request('/backup')).data.dados;assert.equal(backup.versao,3);
        for(const table of ['mensalista_contratos','mensalista_veiculos','mensalista_cobrancas'])assert.ok(backup.tabelas[table].length);
        await admin.request('/operacao/manutencao','POST',{ativo:true,motivo:'Restauração de teste em banco isolado'});
        assert.equal((await admin.request('/restore','POST',{backup,confirmacao:'RESTAURAR',senha:'Senha-segura-123'})).status,200);
        await admin.request('/operacao/manutencao','POST',{ativo:false,motivo:'Conferência de teste concluída com sucesso'});
        await operator.request('/auth/login','POST',{login:'operador',senha:'Senha-segura-123'});
        assert.deepEqual((await operator.request(`/comprovantes/operacao/${original.numero}`)).data.dados,original);
        const old=structuredClone(backup);old.versao=2;for(const table of ['mensalista_contratos','mensalista_veiculos','mensalista_cobrancas'])delete old.tabelas[table];
        old.checksum=createHash('sha256').update(JSON.stringify(old.tabelas)).digest('hex');
        await admin.request('/operacao/manutencao','POST',{ativo:true,motivo:'Restauração de teste em banco isolado'});
        assert.equal((await admin.request('/restore','POST',{backup:old,confirmacao:'RESTAURAR',senha:'Senha-segura-123'})).status,200);
        await admin.request('/operacao/manutencao','POST',{ativo:false,motivo:'Conferência de teste concluída com sucesso'});
        assert.equal((await system.db.query('SELECT COUNT(*)::int AS n FROM mensalista_contratos')).rows[0].n,1);
        const detail=(await admin.request(`/mensalistas/${id}/financeiro`)).data.dados;assert.equal(detail.cobrancas.length,0);assert.equal(detail.contrato.validade,'2027-01-20');
    });
});
