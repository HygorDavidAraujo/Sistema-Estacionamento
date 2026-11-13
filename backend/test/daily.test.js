import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {dailyDeadline,price} from '../services/financial-domain.js';
import {testServer} from './test-database.js';

const rates={inicial:500,adicional:250,diaria:2500,tolerancia:15};
test('diária vale até o horário combinado e cobra somente horas de atraso pela tarifa avulsa',()=>{
    const entry={diarista:true,criado_em:'2026-11-13T11:00:00Z',diaria_retirada_em:'2026-11-13T21:00:00Z',diaria_valor_pago:'25.00'};
    for(const [time,amount] of [['20:59:59',0],['21:00:00',0],['21:00:01',500],['22:00:00',500],['22:00:01',750],['23:00:01',1000]]){
        const result=price(entry,rates,new Date(`2026-11-13T${time}Z`));assert.equal(result.valor_centavos,amount);assert.equal(result.diaria_valor_pago,25);
    }
    assert.equal(dailyDeadline('2026-11-13T18:00',new Date('2026-11-13T11:00:00Z')),'2026-11-13T21:00:00.000Z');
    assert.equal(dailyDeadline('2026-11-14T01:00',new Date('2026-11-13T11:00:00Z')),'2026-11-14T04:00:00.000Z');
    for(const value of ['',null,'amanhã','2026-02-30T18:00','2026-11-13T07:00','2026-11-13T25:00'])assert.throws(()=>dailyDeadline(value,new Date('2026-11-13T11:00:00Z')));
    const legacy=price({diarista:true,criado_em:'2026-11-10T11:00:00Z'},rates,new Date('2026-11-13T11:00:00Z'));
    assert.equal(legacy.valor_centavos,2500);assert.equal(legacy.diaria_legada,true);
});

test('diária antecipada integra entrada, pagamentos, caixa, saída e backup sem duplicação',async t=>{
    let now=new Date('2026-11-13T11:00:00Z');
    const system=await testServer({clock:()=>now});t.after(()=>system.close());const admin=system.client(),other=system.client();
    await admin.request('/auth/setup','POST',{codigo:'test-setup-secret',login:'admin',nome:'Administrador',senha:'Senha-segura-123'});
    await admin.request('/auth/users','POST',{login:'outro',nome:'Outro operador',perfil:'operador',senha:'Senha-segura-123'});
    await other.request('/auth/login','POST',{login:'outro',senha:'Senha-segura-123'});
    const post=(client,path,body)=>client.request(path,'POST',{operacao_id:randomUUID(),...body});
    const opening=await post(admin,'/caixa/turnos/abrir',{fundo_inicial:100});const shift=opening.data.turno_id;
    const body={placa:'ABC1D23',diarista:true,retirada_em:'2026-11-13T18:00',operacao_id:randomUUID(),turno_id:shift,pagamentos:[{forma_pagamento:'Dinheiro',valor_pago:10},{forma_pagamento:'Pix',valor_pago:15}]};
    let entry,receipt,secondShift;
    await t.test('exige turno próprio, horário futuro e pagamento integral calculado no servidor',async()=>{
        const quote=await post(admin,'/entrada/diaria/cotacao',{retirada_em:body.retirada_em});assert.equal(quote.status,200);assert.equal(quote.data.dados.valor,25);assert.equal(quote.data.dados.retirada_em,'2026-11-13T21:00:00.000Z');
        assert.equal((await post(admin,'/entrada',{...body,retirada_em:null})).status,400);
        assert.equal((await post(admin,'/entrada',{...body,retirada_em:'2026-11-13T10:00:00Z'})).status,400);
        assert.equal((await post(admin,'/entrada',{...body,turno_id:null})).status,409);
        assert.equal((await post(other,'/entrada',body)).status,403);
        assert.equal((await post(admin,'/entrada',{...body,pagamentos:[{forma_pagamento:'Dinheiro',valor_pago:1}]})).status,409);
        assert.equal((await system.db.query('SELECT COUNT(*)::int AS n FROM historico')).rows[0].n,0);
    });
    await t.test('falha em uma parcela desfaz entrada, recebimento e recibo; reenvio confirmado não duplica',async()=>{
        await system.pg.exec(`CREATE FUNCTION fail_daily() RETURNS trigger AS $$ BEGIN IF NEW.origem='diaria' AND NEW.forma_pagamento='Pix' THEN RAISE EXCEPTION 'test'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
            CREATE TRIGGER fail_daily BEFORE INSERT ON caixa_movimentos FOR EACH ROW EXECUTE FUNCTION fail_daily();`);
        assert.equal((await post(admin,'/entrada',body)).status,500);
        assert.equal((await system.db.query('SELECT COUNT(*)::int AS n FROM historico')).rows[0].n,0);
        assert.equal((await system.db.query('SELECT COUNT(*)::int AS n FROM caixa_movimentos')).rows[0].n,0);
        await system.pg.exec('DROP TRIGGER fail_daily ON caixa_movimentos; DROP FUNCTION fail_daily();');
        const first=await post(admin,'/entrada',body);assert.equal(first.status,200,JSON.stringify(first.data));entry=first.data.entry_id;receipt=first.data.comprovante;
        assert.deepEqual((await post(admin,'/entrada',body)).data,first.data);
        assert.equal(receipt.total,25);assert.equal(receipt.diaria_retirada_em,'2026-11-13T21:00:00.000Z');assert.equal(String(receipt.turno_id),String(shift));
        assert.deepEqual((await admin.request(`/comprovantes/entrada/${entry}`)).data.dados,receipt);
        assert.deepEqual((await admin.request(`/comprovantes/operacao/${body.operacao_id}`)).data.dados,receipt);
        const summary=(await admin.request('/caixa/dashboard')).data.dados;assert.equal(summary.total_recebido,25);assert.equal(summary.total_dinheiro,10);assert.equal(summary.total_pix,15);assert.equal(summary.total_transacoes,1);assert.equal(summary.total_parcelas,2);assert.equal(summary.diarias,1);
        assert.equal((await post(admin,'/patio/cancel',{entryId:entry,motivo:'Cancelamento de entrada com diária paga'})).status,409);
        const patio=(await admin.request('/patio/ativos')).data.dados.find(row=>row.entry_id===entry);assert.equal(Number(patio.diaria_valor_pago),25);assert.ok(patio.diaria_retirada_em);assert.deepEqual(patio.tarifa,rates);
    });
    await t.test('retirada dentro do prazo não cobra novamente nem duplica a receita nos relatórios',async()=>{
        const second=await post(admin,'/entrada',{...body,placa:'DEF4G56',operacao_id:randomUUID(),pagamentos:[{forma_pagamento:'Dinheiro',valor_pago:25}]});assert.equal(second.status,200);
        const quote=(await post(admin,'/saida/cotacao',{entryId:second.data.entry_id})).data.dados;assert.equal(quote.valor,0);
        const result=await post(admin,'/saida',{cotacao_id:quote.cotacao_id,turno_id:shift,pagamentos:[]});assert.equal(result.status,200);assert.equal(result.data.comprovante.diaria_valor_pago,25);assert.equal(result.data.comprovante.total,0);
        assert.equal(Number((await system.db.query('SELECT valor_pago FROM historico WHERE entry_id=$1',[second.data.entry_id])).rows[0].valor_pago),25);
        const rows=(await admin.request('/caixa/relatorio')).data.dados;assert.equal(rows.reduce((n,r)=>n+Number(r.total),0),50);
    });
    await t.test('antecipação permanece no turno original e atraso é recebido pelo próximo operador',async()=>{
        const s=(await admin.request('/caixa/dashboard')).data.dados;
        assert.equal((await post(admin,'/caixa/turnos/fechar',{turno_id:shift,revisao:s.revisao,contagem:{dinheiro:s.saldo_esperado,credito:0,debito:0,pix:s.total_pix}})).status,200);
        secondShift=(await post(other,'/caixa/turnos/abrir',{fundo_inicial:0})).data.turno_id;
        // Repetir uma diária confirmada devolve o mesmo recibo mesmo após o turno fechar.
        assert.deepEqual((await post(admin,'/entrada',body)).data.comprovante,receipt);
        now=new Date('2026-11-13T20:59:00Z');const old=(await post(other,'/saida/cotacao',{entryId:entry})).data.dados;assert.equal(old.valor,0);
        now=new Date('2026-11-13T21:00:01Z');assert.equal((await post(other,'/saida',{cotacao_id:old.cotacao_id,turno_id:secondShift,pagamentos:[]})).status,409);
        const late=(await post(other,'/saida/cotacao',{entryId:entry})).data.dados;assert.equal(late.valor,5);
        await system.db.query("UPDATE configuracoes SET valor='99.00' WHERE chave IN ('valor_hora_inicial','valor_hora_adicional','valor_diaria')");
        now=new Date('2026-11-13T22:01:00Z');assert.equal((await post(other,'/saida',{cotacao_id:late.cotacao_id,turno_id:secondShift,pagamentos:[{forma_pagamento:'Pix',valor_pago:5}]})).status,409);
        const fresh=(await post(other,'/saida/cotacao',{entryId:entry})).data.dados;assert.equal(fresh.valor,7.5);assert.equal(fresh.atraso_minutos,61);
        const payload={cotacao_id:fresh.cotacao_id,turno_id:secondShift,pagamentos:[{forma_pagamento:'Pix',valor_pago:7.5}],operacao_id:randomUUID()};
        const result=await post(other,'/saida',payload);assert.equal(result.status,200);assert.deepEqual((await post(other,'/saida',payload)).data,result.data);
        assert.equal(result.data.comprovante.diaria_valor_pago,25);assert.equal(result.data.comprovante.total,7.5);
        assert.equal(Number((await system.db.query('SELECT valor_pago FROM historico WHERE entry_id=$1',[entry])).rows[0].valor_pago),32.5);
        const total=(await admin.request('/caixa/relatorio')).data.dados.reduce((n,r)=>n+Number(r.total),0);assert.equal(total,57.5);
        const history=(await admin.request(`/historico/${body.placa}`)).data.dados[0];assert.equal(history.diaria_operacao_id,body.operacao_id);assert.equal(history.forma_pagamento,'Múltiplo');assert.ok(history.operacao_id);
        const current=(await other.request('/caixa/dashboard')).data.dados;assert.equal(current.total_recebido,7.5);assert.equal(current.total_transacoes,1);
    });
    await t.test('backup e restauração preservam horário, antecipação, parcelas e comprovante original',async()=>{
        const backup=(await admin.request('/backup')).data.dados;
        const restored=await admin.request('/restore','POST',{backup,confirmacao:'RESTAURAR',senha:'Senha-segura-123'});assert.equal(restored.status,200,JSON.stringify(restored.data));
        assert.deepEqual((await admin.request(`/comprovantes/entrada/${entry}`)).data.dados,receipt);
        const row=(await system.db.query('SELECT diaria_valor_pago,diaria_retirada_em FROM historico WHERE entry_id=$1',[entry])).rows[0];assert.equal(Number(row.diaria_valor_pago),25);assert.equal(new Date(row.diaria_retirada_em).toISOString(),'2026-11-13T21:00:00.000Z');
    });
});
