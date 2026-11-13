import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {testServer} from './test-database.js';

test('caixa único, recebimentos por responsável, conferência e versões de fechamento',async t=>{
    const system=await testServer();t.after(()=>system.close());
    const admin=system.client(),a=system.client(),b=system.client();let shift,conference,closed,closeBody;
    const post=(client,path,body={})=>client.request(path,'POST',{operacao_id:randomUUID(),...body});
    const summary=async client=>(await client.request(`/caixa/turnos/${shift}/resumo`)).data.dados.resumo;
    const count=s=>({dinheiro:s.saldo_esperado,credito:s.total_credito,debito:s.total_debito,pix:s.total_pix});
    await admin.request('/auth/setup','POST',{codigo:'test-setup-secret',login:'admin',nome:'Administrador',senha:'Senha-segura-123'});
    for(const login of ['operador-a','operador-b'])await admin.request('/auth/users','POST',{login,nome:login,perfil:'operador',senha:'Senha-segura-123'});
    await a.request('/auth/login','POST',{login:'operador-a',senha:'Senha-segura-123'});await b.request('/auth/login','POST',{login:'operador-b',senha:'Senha-segura-123'});
    await t.test('migração preserva turnos antigos sem atribuir caixa nem encerrar registros',async()=>{
        await system.db.query("INSERT INTO caixa_turnos (observacao_abertura) VALUES ('turno antigo')");
        assert.equal((await system.db.query("SELECT estado FROM caixa_turnos WHERE observacao_abertura='turno antigo'")).rows[0].estado,'legado');
        assert.equal((await a.request('/caixa/turnos/atual')).data.dados,null);
    });
    await t.test('saída é recusada sem turno; abertura valida fundo e é idempotente',async()=>{
        const entry=await post(a,'/entrada',{placa:'ABC1D23'});assert.equal(entry.status,200);
        const quote=(await post(a,'/saida/cotacao',{entryId:entry.data.entry_id})).data.dados;
        assert.equal((await post(a,'/saida',{cotacao_id:quote.cotacao_id,pagamentos:[]})).status,409);
        assert.equal((await post(a,'/caixa/turnos/abrir',{fundo_inicial:-1})).status,400);
        const payload={fundo_inicial:100,operacao_id:randomUUID()};
        const first=await post(a,'/caixa/turnos/abrir',payload),again=await post(a,'/caixa/turnos/abrir',payload);
        assert.equal(first.status,200);assert.deepEqual(first.data,again.data);shift=first.data.turno_id;
        assert.equal((await summary(a)).saldo_esperado,100);
        const details=(await a.request(`/caixa/turnos/${shift}/resumo`)).data.dados;
        assert.deepEqual(details.abertura,first.data.comprovante);
        assert.deepEqual((await a.request(`/caixa/comprovantes/${payload.operacao_id}`)).data.dados,first.data.comprovante);
        assert.equal((await b.request(`/caixa/comprovantes/${payload.operacao_id}`)).status,403);
        await system.db.query("INSERT INTO caixa_fechamentos (data_ref,total_recebido) VALUES ('2020-01-01',25),('2020-02-01',30)");
        const legacy=(await admin.request('/caixa/fechamentos?dataInicio=2020-01-01&dataFim=2020-01-31')).data.legados;
        assert.equal(legacy.length,1);assert.equal(legacy[0].data_iso,'2020-01-01');
    });
    await t.test('caixa aberto é único inclusive com duas solicitações simultâneas e restrição no banco',async()=>{
        const results=await Promise.all([post(b,'/caixa/turnos/abrir',{fundo_inicial:0}),post(admin,'/caixa/turnos/abrir',{fundo_inicial:0})]);
        assert.deepEqual(results.map(r=>r.status),[409,409]);
        await assert.rejects(system.db.query("INSERT INTO caixa_turnos (estado,operador_id,operador_nome) VALUES ('aberto',99,'outro')"),error=>error.code==='23505');
        assert.equal((await b.request('/caixa/turnos/atual')).data.dados.resumo,null);
        assert.equal((await b.request(`/caixa/turnos/${shift}/resumo`)).status,403);
    });
    await t.test('sangria e suprimento são separados da receita, validados e não duplicam no reenvio',async()=>{
        const supply={turno_id:shift,tipo:'suprimento',valor:20,motivo:'Reforço autorizado de troco',operacao_id:randomUUID()};
        assert.equal((await post(a,'/caixa/ajustes',supply)).status,200);assert.equal((await post(a,'/caixa/ajustes',supply)).status,200);
        assert.equal((await post(a,'/caixa/ajustes',{turno_id:shift,tipo:'sangria',valor:10,motivo:'Retirada para o cofre'})).status,200);
        assert.equal((await post(a,'/caixa/ajustes',{turno_id:shift,tipo:'sangria',valor:111,motivo:'Retirada para o cofre'})).status,409);
        assert.equal((await post(a,'/caixa/ajustes',{turno_id:shift,tipo:'suprimento',valor:1,motivo:'curto'})).status,400);
        const s=await summary(a);assert.equal(s.total_recebido,0);assert.equal(s.saldo_esperado,110);assert.equal(s.suprimentos,20);assert.equal(s.sangrias,10);
    });
    await t.test('saída dividida e mensalidade pertencem ao turno certo, inclusive saída gratuita',async()=>{
        await system.db.query("UPDATE historico SET criado_em=NOW()-INTERVAL '65 minutes' WHERE placa='ABC1D23'");
        const entry=(await system.db.query("SELECT entry_id FROM historico WHERE placa='ABC1D23'")).rows[0].entry_id;
        const quote=(await post(a,'/saida/cotacao',{entryId:entry})).data.dados;
        assert.equal((await post(b,'/saida',{turno_id:shift,cotacao_id:quote.cotacao_id,pagamentos:[]})).status,403);
        const paid=await post(a,'/saida',{turno_id:shift,cotacao_id:quote.cotacao_id,pagamentos:[{forma_pagamento:'Dinheiro',valor_pago:2.5},{forma_pagamento:'Pix',valor_pago:5}]});assert.equal(paid.status,200);assert.equal(String(paid.data.comprovante.turno_id),String(shift));
        const free=await post(a,'/entrada',{placa:'DEF4G56'});const q=(await post(a,'/saida/cotacao',{entryId:free.data.entry_id})).data.dados;
        assert.equal((await post(a,'/saida',{turno_id:shift,cotacao_id:q.cotacao_id,pagamentos:[]})).status,200);
        const id=(await system.db.query("INSERT INTO mensalistas (placa,nome) VALUES ('GHI7J89','Cliente mensal') RETURNING id")).rows[0].id;
        const monthlyQuote=(await post(a,`/mensalistas/${id}/cotacao`,{meses:1})).data.dados;
        assert.equal((await post(a,'/mensalistas/pagamentos',{turno_id:shift,mensalista_id:id,meses:1,revisao:monthlyQuote.revisao,cobranca_id:monthlyQuote.cobranca_id,periodo_previsto:monthlyQuote.fim_periodo,pagamentos:[{forma_pagamento:'Dinheiro',valor_pago:300}]})).status,200);
        const s=await summary(a);assert.equal(s.total_recebido,307.5);assert.equal(s.saldo_esperado,412.5);assert.equal(s.total_transacoes,2);assert.equal(s.total_parcelas,3);assert.equal(s.saidas,2);
        const rows=(await system.db.query('SELECT DISTINCT operador_id,turno_id FROM caixa_movimentos')).rows;assert.equal(rows.length,1);assert.equal(String(rows[0].turno_id),String(shift));
    });
    await t.test('fechamento rejeita resumo desatualizado e preserva veículos no pátio',async()=>{
        await post(a,'/entrada',{placa:'JKL1M23'});const stale=await summary(a);
        await post(a,'/caixa/ajustes',{turno_id:shift,tipo:'suprimento',valor:5,motivo:'Reposição autorizada de troco'});
        assert.equal((await post(a,'/caixa/turnos/fechar',{turno_id:shift,revisao:stale.revisao,contagem:count(stale)})).status,409);
        const s=await summary(a);const counted=count(s);counted.dinheiro-=1;
        assert.equal((await post(a,'/caixa/turnos/fechar',{turno_id:shift,revisao:s.revisao,contagem:counted})).status,400);
        closeBody={operacao_id:randomUUID(),turno_id:shift,revisao:s.revisao,contagem:counted,motivo:'Diferença identificada na contagem física'};
        const first=await post(a,'/caixa/turnos/fechar',closeBody);assert.equal(first.status,200);closed=first.data;conference=closed.conferencia_id;
        assert.equal(closed.estado,'aguardando_aprovacao');assert.equal(closed.comprovante.diferencas.dinheiro,-1);
        assert.deepEqual((await post(a,'/caixa/turnos/fechar',closeBody)).data,closed);
        assert.equal((await system.db.query("SELECT status FROM historico WHERE placa='JKL1M23'")).rows[0].status,'ativo');
        assert.equal((await post(a,'/caixa/ajustes',{turno_id:shift,tipo:'suprimento',valor:5,motivo:'Reposição autorizada de troco'})).status,409);
    });
    await t.test('aprovação exige supervisor e mantém a diferença original registrada',async()=>{
        assert.equal((await post(a,`/caixa/conferencias/${conference}/aprovar`,{motivo:'Diferença analisada na conferência'})).status,403);
        assert.equal((await post(admin,`/caixa/conferencias/${conference}/aprovar`,{motivo:'Diferença analisada e autorizada'})).status,200);
        const row=(await system.db.query('SELECT * FROM caixa_conferencias WHERE id=$1',[conference])).rows[0];assert.equal(row.estado,'aprovado');assert.equal(row.diferencas.dinheiro,-1);assert.equal(row.contagem.dinheiro,416.5);
    });
    await t.test('troca de operador e reabertura geram nova versão sem sobrescrever o fechamento original',async()=>{
        const next=(await post(b,'/caixa/turnos/abrir',{fundo_inicial:20})).data.turno_id;
        assert.equal((await post(admin,`/caixa/turnos/${shift}/reabrir`,{motivo:'Recontagem do caixa para correção'})).status,409);
        let s=(await b.request(`/caixa/turnos/${next}/resumo`)).data.dados.resumo;
        assert.equal((await post(b,'/caixa/turnos/fechar',{turno_id:next,revisao:s.revisao,contagem:count(s)})).status,200);
        assert.equal((await post(admin,`/caixa/turnos/${shift}/reabrir`,{motivo:'Recontagem do caixa para correção'})).status,200);
        s=await summary(a);const corrected=await post(a,'/caixa/turnos/fechar',{turno_id:shift,revisao:s.revisao,contagem:count(s)});assert.equal(corrected.status,200);assert.equal(corrected.data.comprovante.versao,2);
        const old=(await system.db.query('SELECT * FROM caixa_conferencias WHERE id=$1',[conference])).rows[0];assert.ok(old.substituida_em);assert.deepEqual(old.comprovante,closed.comprovante);
        const consolidated=(await admin.request('/caixa/consolidado')).data.dados;assert.equal(consolidated.turnos,2);assert.equal(consolidated.receita,307.5);assert.equal(consolidated.diferenca_dinheiro,0);
        const page1=(await admin.request('/caixa/turnos?limite=1&pagina=1')).data,page2=(await admin.request('/caixa/turnos?limite=1&pagina=2')).data;
        assert.equal(page1.dados.length,1);assert.equal(page2.dados.length,1);assert.notEqual(page1.dados[0].id,page2.dados[0].id);assert.equal(page1.paginacao.total,3);
        const history=(await admin.request('/caixa/fechamentos?limite=1')).data;assert.equal(history.paginacao.total,3);assert.equal(history.dados.length,1);assert.equal(history.paginacao_legados.total,2);
    });
    await t.test('backup contém ajustes, conferências e versões e restaura os relacionamentos',async()=>{
        const backup=(await admin.request('/backup')).data.dados;assert.equal(backup.versao,3);
        for(const name of ['caixa_ajustes','caixa_conferencias','caixa_acoes'])assert.ok(backup.tabelas[name].length);
        await admin.request('/operacao/manutencao','POST',{ativo:true,motivo:'Restauração de teste em banco isolado'});
        const restored=await admin.request('/restore','POST',{backup,confirmacao:'RESTAURAR',senha:'Senha-segura-123'});assert.equal(restored.status,200,JSON.stringify(restored.data));
        await admin.request('/operacao/manutencao','POST',{ativo:false,motivo:'Conferência de teste concluída com sucesso'});
        await b.request('/auth/login','POST',{login:'operador-b',senha:'Senha-segura-123'});
        assert.equal((await system.db.query('SELECT COUNT(*)::int AS n FROM caixa_conferencias')).rows[0].n,3);
        assert.equal((await post(b,'/caixa/turnos/abrir',{fundo_inicial:0})).status,200);
    });
    await t.test('backup da etapa anterior é convertido para legado sem inventar vínculos financeiros',async()=>{
        const backup=(await admin.request('/backup')).data.dados;backup.versao=1;
        for(const name of ['caixa_ajustes','caixa_conferencias','caixa_acoes','mensalista_contratos','mensalista_veiculos','mensalista_cobrancas'])delete backup.tabelas[name];
        for(const row of backup.tabelas.caixa_turnos)for(const key of ['operador_id','operador_nome','fundo_inicial','estado','revisao','ultima_conferencia_id'])delete row[key];
        for(const row of backup.tabelas.caixa_movimentos)for(const key of ['turno_id','operador_id','operador_nome'])delete row[key];
        for(const row of backup.tabelas.operacoes_financeiras)delete row.turno_id;
        backup.checksum=createHash('sha256').update(JSON.stringify(backup.tabelas)).digest('hex');
        await admin.request('/operacao/manutencao','POST',{ativo:true,motivo:'Restauração de teste em banco isolado'});
        const restored=await admin.request('/restore','POST',{backup,confirmacao:'RESTAURAR',senha:'Senha-segura-123'});assert.equal(restored.status,200,JSON.stringify(restored.data));
        await admin.request('/operacao/manutencao','POST',{ativo:false,motivo:'Conferência de teste concluída com sucesso'});
        await a.request('/auth/login','POST',{login:'operador-a',senha:'Senha-segura-123'});await b.request('/auth/login','POST',{login:'operador-b',senha:'Senha-segura-123'});
        assert.equal((await system.db.query("SELECT COUNT(*)::int AS n FROM caixa_turnos WHERE estado<>'legado'")).rows[0].n,0);
        assert.equal((await system.db.query('SELECT COUNT(*)::int AS n FROM caixa_movimentos WHERE turno_id IS NOT NULL')).rows[0].n,0);
    });
    await t.test('duas aberturas concorrentes com caixa livre aceitam exatamente uma',async()=>{
        const results=await Promise.all([post(a,'/caixa/turnos/abrir',{fundo_inicial:0}),post(b,'/caixa/turnos/abrir',{fundo_inicial:0})]);
        assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
        assert.equal((await system.db.query("SELECT COUNT(*)::int AS n FROM caixa_turnos WHERE estado='aberto'")).rows[0].n,1);
    });
});

test('turno atravessa meia-noite mantendo recebimento e fechamento na data operacional de abertura',async t=>{
    let instant=new Date('2026-12-01T02:50:00Z');
    const system=await testServer({clock:()=>instant});t.after(()=>system.close());const admin=system.client();
    await admin.request('/auth/setup','POST',{codigo:'test-setup-secret',login:'admin',nome:'Administrador',senha:'Senha-segura-123'});
    const post=(path,body)=>admin.request(path,'POST',{operacao_id:randomUUID(),...body});
    const turno=(await post('/caixa/turnos/abrir',{fundo_inicial:0})).data.turno_id;
    const entry=(await post('/entrada',{placa:'ABC1D23'})).data.entry_id;
    instant=new Date('2026-12-01T03:10:00Z');
    const quote=(await post('/saida/cotacao',{entryId:entry})).data.dados;
    assert.equal((await post('/saida',{turno_id:turno,cotacao_id:quote.cotacao_id,pagamentos:[{forma_pagamento:'Dinheiro',valor_pago:5}]})).status,200);
    const summary=(await admin.request(`/caixa/turnos/${turno}/resumo`)).data.dados.resumo;
    const closed=await post('/caixa/turnos/fechar',{turno_id:turno,revisao:summary.revisao,contagem:{dinheiro:5,credito:0,debito:0,pix:0}});assert.equal(closed.status,200);
    const consolidated=(await admin.request('/caixa/consolidado?dataInicio=2026-11-30&dataFim=2026-11-30')).data.dados;
    assert.equal(consolidated.turnos,1);assert.equal(consolidated.receita,5);
    assert.equal((await admin.request('/caixa/consolidado?dataInicio=2026-12-01&dataFim=2026-12-01')).data.dados.turnos,0);
});
