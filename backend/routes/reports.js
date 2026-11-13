import express from 'express';
import {audit,fail} from '../services/financial-domain.js';
import {filters,paging,pageInfo,csvText} from '../services/query-domain.js';
import {normalizePlate} from '../services/plate-domain.js';
const financeRoles=['supervisor','financeiro','administrador'];
// Base única de recebimentos; permanências antigas entram apenas quando não há movimento financeiro.
const ledger=`WITH movimentos AS (
    SELECT cm.id,cm.operacao_chave,CASE WHEN cm.operacao_chave IS NOT NULL THEN 'op:'||cm.operacao_chave ELSE 'mov:'||cm.id::text END AS recebimento,
           cm.data_pagamento AS data_ref,cm.hora_pagamento,cm.forma_pagamento,cm.valor_pago,cm.origem,cm.placa,cm.nome,cm.turno_id,cm.operador_id,cm.operador_nome,
           CASE WHEN cm.origem='mensalidade' OR h.mensalista THEN 'mensalista' WHEN h.diarista OR cm.origem='diaria' THEN 'diarista' ELSE 'avulso' END AS categoria,
           cm.operacao_chave IS NULL AS legado
    FROM caixa_movimentos cm LEFT JOIN historico h ON h.id=cm.historico_id
    UNION ALL
    SELECT h.id,NULL,'hist:'||h.id::text,h.data_saida,h.hora_saida,h.forma_pagamento,h.valor_pago,'saida',h.placa,h.cliente_nome,NULL,NULL,NULL,
           CASE WHEN h.mensalista THEN 'mensalista' WHEN h.diarista THEN 'diarista' ELSE 'avulso' END,true
    FROM historico h WHERE h.status='saído' AND h.valor_pago>0
       AND NOT EXISTS (SELECT 1 FROM caixa_movimentos cm WHERE cm.historico_id=h.id AND cm.origem IN ('saida','diaria'))
)`;
function financialFilter(input){
    const f=filters(input,'data_ref');
    for(const [key,column,options]of [['origem','origem',['saida','diaria','mensalidade']],['tipo','categoria',['avulso','diarista','mensalista']],['forma','forma_pagamento',['Dinheiro','Pix','Cartão de Crédito','Cartão de Débito']]])if(input[key]){
        if(!options.includes(input[key]))fail('Filtro financeiro inválido');f.add(`${column}=?`,input[key]);
    }
    for(const [key,column]of [['turno_id','turno_id'],['operador_id','operador_id']])if(input[key]){if(!/^\d+$/.test(String(input[key])))fail('Filtro de responsável/turno inválido');f.add(`${column}=?`,input[key]);}
    if(input.placa){const plate=normalizePlate(input.placa);if(!plate||plate.length>7)fail('Filtro de placa inválido');f.add('placa ILIKE ?',`%${plate}%`);}
    return f;
}
function vehicleFilter(input){
    if(input.criterio&&!['entrada','saida'].includes(input.criterio))fail('Critério de data inválido');
    const f=filters(input,input.criterio==='saida'?'data_saida':'data_entrada');
    if(input.tipo){if(!['avulso','diarista','mensalista'].includes(input.tipo))fail('Tipo de veículo inválido');f.parts.push(input.tipo==='avulso'?'NOT mensalista AND NOT diarista':input.tipo==='diarista'?'diarista=true':'mensalista=true');}
    if(input.status){if(!['ativo','saído','cancelado'].includes(input.status))fail('Situação da permanência inválida');f.add('status=?',input.status);}
    if(input.placa){const plate=normalizePlate(input.placa);if(!plate||plate.length>7)fail('Filtro de placa inválido');f.add('placa ILIKE ?',`%${plate}%`);}
    if(input.operador){if(String(input.operador).length>120)fail('Nome de operador muito longo');f.add("comprovante_entrada->>'operador' ILIKE ?",`%${input.operador}%`);}
    return f;
}
const vehicleColumns=`h.*,TO_CHAR(data_entrada,'DD/MM/YYYY') AS data_entrada,TO_CHAR(hora_entrada,'HH24:MI:SS') AS hora_entrada,
    TO_CHAR(data_saida,'DD/MM/YYYY') AS data_saida,TO_CHAR(hora_saida,'HH24:MI:SS') AS hora_saida,
    (SELECT chave FROM operacoes_financeiras WHERE tipo='saida' AND referencia=h.id ORDER BY criado_em DESC LIMIT 1) AS operacao_id,
    (SELECT chave FROM operacoes_financeiras WHERE tipo='diaria' AND referencia=h.id LIMIT 1) AS diaria_operacao_id,
    comprovante_entrada->>'operador' AS operador_entrada`;
export function createReportsRouter({query,tx,allow,timeZone='America/Sao_Paulo'}){
    const router=express.Router(),handle=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(error){next(error);}};
    async function vehicles(input,exporting=false){
        return tx(async client=>{
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const f=vehicleFilter(input),p=paging(input),total=(await client.query(`SELECT COUNT(*)::int AS n FROM historico${f.where()}`,f.params)).rows[0].n;
        const rows=(await client.query(`SELECT ${vehicleColumns} FROM historico h${f.where()} ORDER BY criado_em DESC,id DESC LIMIT $${f.params.length+1} OFFSET $${f.params.length+2}`,[...f.params,exporting?20001:p.size,exporting?0:p.offset])).rows;
        return {success:true,dados:rows,paginacao:pageInfo(p,total),criterio:input.criterio||'entrada'};
        });
    }
    async function financeSummary(input,dbQuery=query){
        const f=financialFilter(input);
        return (await dbQuery(`${ledger} SELECT COUNT(DISTINCT recebimento)::int AS recebimentos,COUNT(*)::int AS parcelas,COUNT(*) FILTER (WHERE legado)::int AS parcelas_legadas,
            COALESCE(SUM(valor_pago),0) AS total,COALESCE(SUM(valor_pago) FILTER (WHERE origem='saida'),0) AS saidas,
            COALESCE(SUM(valor_pago) FILTER (WHERE origem='diaria'),0) AS diarias,COALESCE(SUM(valor_pago) FILTER (WHERE origem='mensalidade'),0) AS mensalidades,
            COALESCE(SUM(valor_pago) FILTER (WHERE forma_pagamento='Dinheiro'),0) AS dinheiro,COALESCE(SUM(valor_pago) FILTER (WHERE forma_pagamento='Pix'),0) AS pix,
            COALESCE(SUM(valor_pago) FILTER (WHERE forma_pagamento='Cartão de Crédito'),0) AS credito,COALESCE(SUM(valor_pago) FILTER (WHERE forma_pagamento='Cartão de Débito'),0) AS debito
            FROM movimentos${f.where()}`,f.params)).rows[0];
    }
    async function financialRows(input,exporting=false){
        return tx(async client=>{
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const f=financialFilter(input),p=paging(input),summary=await financeSummary(input,(...args)=>client.query(...args));
        const rows=(await client.query(`${ledger} SELECT recebimento,MAX(operacao_chave) AS operacao_id,TO_CHAR(MAX(data_ref),'YYYY-MM-DD') AS data_ref,
            MAX(placa) AS placa,MAX(nome) AS cliente,MAX(origem) AS origem,MAX(operador_nome) AS operador,MAX(turno_id) AS turno_id,
            SUM(valor_pago) AS total,COUNT(*)::int AS parcelas,BOOL_OR(legado) AS legado,
            json_agg(json_build_object('forma',forma_pagamento,'valor',valor_pago) ORDER BY id) AS pagamentos
            FROM movimentos${f.where()} GROUP BY recebimento ORDER BY MAX(data_ref) DESC,recebimento DESC LIMIT $${f.params.length+1} OFFSET $${f.params.length+2}`,[...f.params,exporting?20001:p.size,exporting?0:p.offset])).rows;
        return {success:true,dados:rows,resumo:summary,paginacao:pageInfo(p,summary.recebimentos),criterio:'Data de recebimento; fundos, sangrias e suprimentos fora da receita'};
        });
    }
    router.get('/historico',handle(async(req,res)=>res.json(await vehicles(req.query))));
    router.get('/historico/:placa',handle(async(req,res)=>res.json(await vehicles({...req.query,placa:req.params.placa}))));
    router.get('/relatorio/resumo',allow(...financeRoles),handle(async(req,res)=>{
        const f=vehicleFilter(req.query),financial=await financeSummary(req.query);
        const operational=(await query(`SELECT COUNT(*)::int AS total_movimentacoes,COUNT(*) FILTER (WHERE status='saído')::int AS total_saidas,
            COUNT(*) FILTER (WHERE status='ativo')::int AS veiculos_no_patio,COUNT(*) FILTER (WHERE status='cancelado')::int AS cancelamentos,
            COUNT(*) FILTER (WHERE status='saído' AND COALESCE(valor_pago,0)=0)::int AS saidas_sem_cobranca,COUNT(DISTINCT placa)::int AS total_veiculos_unicos,
            COALESCE(AVG(EXTRACT(EPOCH FROM ((data_saida+hora_saida)-(data_entrada+hora_entrada)))) FILTER (WHERE status='saído'),0) AS permanencia_media_segundos
            FROM historico${f.where()}`,f.params)).rows[0];
        res.json({success:true,dados:{...operational,receita_total:financial.total,valor_medio:financial.recebimentos?Number(financial.total)/financial.recebimentos:0,recebimentos:financial.recebimentos,parcelas:financial.parcelas,mensalidades:financial.mensalidades,diarias:financial.diarias},criterio:{operacional:req.query.criterio||'entrada',financeiro:'Data de recebimento',filtros:req.query}});
    }));
    router.get('/caixa/relatorio',allow(...financeRoles),handle(async(req,res)=>{
        const f=financialFilter(req.query),summary=await financeSummary(req.query);
        const rows=(await query(`${ledger} SELECT TO_CHAR(data_ref,'DD/MM/YYYY') AS data_saida,TO_CHAR(data_ref,'YYYY-MM-DD') AS data_iso,forma_pagamento,
            COUNT(*)::int AS quantidade,COUNT(DISTINCT recebimento)::int AS recebimentos,SUM(valor_pago) AS total FROM movimentos${f.where()} GROUP BY data_ref,forma_pagamento ORDER BY data_ref DESC,forma_pagamento`,f.params)).rows;
        res.json({success:true,dados:rows,resumo:summary,criterio:'Data do recebimento'});
    }));
    router.get('/relatorios/financeiro',allow(...financeRoles),handle(async(req,res)=>res.json(await financialRows(req.query))));
    router.get('/relatorios/financeiro.csv',allow(...financeRoles),handle(async(req,res)=>{
        const data=await financialRows(req.query,true);if(data.dados.length>20000)fail('Refine o período para exportar até 20 mil recebimentos',413);
        await tx(client=>audit(client,req.user,'relatorio_financeiro_exportacao',{filtros:req.query,total:data.resumo.total,recebimentos:data.resumo.recebimentos}));
        res.type('text/csv').attachment(`recebimentos-${req.query.dataInicio||'inicio'}-${req.query.dataFim||'fim'}.csv`).send(csvText([
            ['Critério','Data de recebimento','Total recebido',data.resumo.total,'Recebimentos',data.resumo.recebimentos,'Parcelas',data.resumo.parcelas],
            ['Filtros aplicados',JSON.stringify(req.query)],
            ['Data','Origem','Placa','Cliente','Operador','Turno','Total','Parcelas','Pagamentos','Operação','Legado'],
            ...data.dados.map(r=>[r.data_ref,r.origem,r.placa,r.cliente,r.operador,r.turno_id,r.total,r.parcelas,r.pagamentos.map(p=>`${p.forma}: ${p.valor}`).join(' / '),r.operacao_id,r.legado?'Sim':'Não'])]));
    }));
    router.get('/relatorios/historico.csv',allow(...financeRoles),handle(async(req,res)=>{
        const data=await vehicles(req.query,true);if(data.dados.length>20000)fail('Refine o período para exportar até 20 mil permanências',413);
        await tx(client=>audit(client,req.user,'historico_exportacao',{filtros:req.query,registros:data.dados.length}));
        res.type('text/csv').attachment('permanencias.csv').send(csvText([['Critério de data',data.criterio],['Filtros aplicados',JSON.stringify(req.query)],['Ticket','Placa','Categoria','Entrada','Saída','Situação','Total da permanência','Operador'],...data.dados.map(r=>[r.entry_id,r.placa,r.mensalista?'Mensalista':r.diarista?'Diária':'Avulso',`${r.data_entrada} ${r.hora_entrada}`,r.data_saida?`${r.data_saida} ${r.hora_saida}`:'',r.status,r.valor_pago,r.operador_entrada])]));
    }));
    router.get('/relatorios/receber',allow(...financeRoles),handle(async(req,res)=>{
        const p=paging(req.query),f=filters(req.query,'b.vencimento');f.parts.push("b.estado IN ('aberta','parcial')");
        const from='FROM mensalista_cobrancas b JOIN mensalista_contratos c ON c.id=b.contrato_id JOIN mensalistas m ON m.id=c.mensalista_id';
        const summary=(await query(`SELECT COUNT(*)::int AS total,COALESCE(SUM(b.total-b.pago),0) AS saldo ${from}${f.where()}`,f.params)).rows[0];
        const rows=(await query(`SELECT b.id,m.nome,m.placa,c.plano,c.estado AS contrato_estado,b.estado,TO_CHAR(b.vencimento,'YYYY-MM-DD') AS vencimento,b.total,b.pago,b.total-b.pago AS saldo ${from}${f.where()} ORDER BY b.vencimento,b.id LIMIT $${f.params.length+1} OFFSET $${f.params.length+2}`,[...f.params,p.size,p.offset])).rows;
        res.json({success:true,dados:rows,resumo:summary,paginacao:pageInfo(p,summary.total),criterio:'Cobranças antecipadas emitidas; vencidos sem cobrança emitida não geram dívida automática'});
    }));
    router.get('/auditoria',allow('supervisor','administrador'),handle(async(req,res)=>{
        const p=paging(req.query,500),f=filters(req.query,`(criado_em AT TIME ZONE '${timeZone.replace(/'/g,"''")}')::date`);
        if(req.query.acao)f.add('acao ILIKE ?',`%${String(req.query.acao).slice(0,120)}%`);
        if(req.query.operador)f.add('usuario_nome ILIKE ?',`%${String(req.query.operador).slice(0,120)}%`);
        const total=(await query(`SELECT COUNT(*)::int AS n FROM auditoria${f.where()}`,f.params)).rows[0].n;
        const rows=(await query(`SELECT * FROM auditoria${f.where()} ORDER BY id DESC LIMIT $${f.params.length+1} OFFSET $${f.params.length+2}`,[...f.params,p.size,p.offset])).rows;
        res.json({success:true,dados:rows,paginacao:pageInfo(p,total)});
    }));
    return router;
}
