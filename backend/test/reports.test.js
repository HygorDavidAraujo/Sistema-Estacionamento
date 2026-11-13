import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {testServer} from './test-database.js';
import {csvCell} from '../services/query-domain.js';

test('CSV trata fórmulas e aspas sem executar conteúdo fornecido pelo usuário',()=>{
    assert.equal(csvCell('=HYPERLINK("x")'),'"\'=HYPERLINK(""x"")"');assert.equal(csvCell('Texto normal'),'"Texto normal"');
});
test('relatórios usam recebimentos únicos, filtros completos, paginação e exportação coerente',async t=>{
    const s=await testServer();t.after(()=>s.close());const admin=s.client(),operator=s.client();
    await admin.request('/auth/setup','POST',{codigo:'test-setup-secret',login:'admin',nome:'Administrador',senha:'Senha-segura-123'});
    await admin.request('/auth/users','POST',{login:'operador',nome:'Operador',perfil:'operador',senha:'Senha-segura-123'});await operator.request('/auth/login','POST',{login:'operador',senha:'Senha-segura-123'});
    const shift=(await admin.request('/caixa/turnos/abrir','POST',{operacao_id:randomUUID(),fundo_inicial:100})).data.turno_id;
    const first=(await s.db.query("INSERT INTO historico (entry_id,placa,status,data_entrada,data_saida,hora_entrada,hora_saida,valor_pago,diarista) VALUES ('daily-report','ABC1D23','saído','2026-10-31','2026-11-01','08:00','18:00',30,true) RETURNING id")).rows[0].id;
    await s.db.query("INSERT INTO caixa_movimentos (origem,historico_id,placa,data_pagamento,valor_pago,forma_pagamento,operacao_chave,turno_id,operador_nome) VALUES ('diaria',$1,'ABC1D23','2026-10-31',10,'Dinheiro','daily-payment',$2,'Administrador'),('diaria',$1,'ABC1D23','2026-10-31',15,'Pix','daily-payment',$2,'Administrador'),('saida',$1,'ABC1D23','2026-11-01',5,'Pix','late-payment',$2,'Administrador')",[first,shift]);
    await s.db.query("INSERT INTO caixa_movimentos (origem,placa,nome,data_pagamento,valor_pago,forma_pagamento,operacao_chave,turno_id) VALUES ('mensalidade','DEF4G56','=cliente','2026-11-01',300,'Dinheiro','monthly-payment',$1)",[shift]);
    await s.db.query("INSERT INTO historico (entry_id,placa,status,data_entrada,data_saida,hora_entrada,hora_saida,valor_pago) VALUES ('legacy-report','GHI7J89','saído','2026-11-01','2026-11-01','08:00','10:00',7.5),('free-report','JKL1M23','saído','2026-11-01','2026-11-01','08:00','08:01',0)");
    await t.test('origens diferentes e mensalidade integram receita uma vez; pagamento dividido é um recebimento',async()=>{
        const r=await admin.request('/relatorios/financeiro');assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(Number(r.data.resumo.total),337.5);assert.equal(r.data.resumo.recebimentos,4);assert.equal(r.data.resumo.parcelas,5);
        assert.equal(r.data.dados.find(r=>r.operacao_id==='daily-payment').parcelas,2);
        assert.equal((await operator.request('/relatorios/financeiro')).status,403);assert.equal((await operator.request('/auditoria')).status,403);
        const summary=(await admin.request('/relatorio/resumo')).data.dados;assert.equal(Number(summary.receita_total),337.5);assert.equal(summary.total_saidas,3);assert.equal(summary.saidas_sem_cobranca,1);
    });
    await t.test('período financeiro usa recebimento e histórico diferencia entrada/saída; mês isolado funciona',async()=>{
        const november=(await admin.request('/relatorios/financeiro?dataInicio=2026-11-01&dataFim=2026-11-30')).data;assert.equal(Number(november.resumo.total),312.5);
        const october=(await admin.request('/historico?mes=10')).data;assert.equal(october.paginacao.total,1);
        assert.equal((await admin.request('/historico?mes=11&criterio=saida')).data.paginacao.total,3);
        assert.equal((await admin.request('/historico?mes=11&criterio=entrada')).data.paginacao.total,2);
        assert.equal((await admin.request('/historico?mes=13')).status,400);assert.equal((await admin.request('/historico?dataInicio=2026-12-01&dataFim=2026-11-01')).status,400);
        const filtered=(await admin.request('/relatorios/financeiro?origem=diaria&forma=Pix')).data;assert.equal(Number(filtered.resumo.total),15);assert.equal(filtered.resumo.recebimentos,1);
    });
    await t.test('paginação mantém totais completos e CSV usa o mesmo filtro com proteção de fórmulas',async()=>{
        const first=(await admin.request('/relatorios/financeiro?pagina=1&limite=2')).data,second=(await admin.request('/relatorios/financeiro?pagina=2&limite=2')).data;
        assert.equal(first.dados.length,2);assert.equal(second.dados.length,2);assert.equal(first.paginacao.total,4);assert.equal(Number(second.resumo.total),337.5);
        assert.equal(new Set([...first.dados,...second.dados].map(r=>r.recebimento)).size,4);
        const exported=await fetch(s.url+'/relatorios/financeiro.csv?origem=mensalidade',{headers:{Cookie:admin.cookie}});assert.equal(exported.status,200);const text=await exported.text();assert.ok(text.includes("'=cliente"));assert.ok(text.includes('300'));assert.ok(!text.includes('daily-payment'));
        assert.equal((await admin.request('/relatorios/financeiro?limite=-1')).status,400);
        assert.ok((await admin.request('/auditoria?acao=relatorio_financeiro_exportacao')).data.dados.some(r=>r.usuario_nome==='Administrador'));
    });
});
