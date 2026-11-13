import express from 'express';
import {audit,fail,cents,civilDate,operationKey} from '../services/financial-domain.js';
import {reason} from '../services/cash-domain.js';
import {civilToday,paging,pageInfo,csvText} from '../services/query-domain.js';
import {lockSubscription,monthlyQuote,createInvoice,customerInput,contractInput,subscriptionState,invoiceColumns} from '../services/subscription-domain.js';
import {normalizePlate,isValidPlate} from '../services/plate-domain.js';
const managers=['supervisor','administrador'];
const receiving=['operador','supervisor','financeiro','administrador'];
export function createSubscriptionsRouter({query,tx,allow,clock=()=>new Date(),timeZone='America/Sao_Paulo'}){
    const router=express.Router(),handle=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(error){next(error);}};
    const today=()=>civilToday(clock(),timeZone);
    const dataset=`SELECT m.*,TO_CHAR(m.vencimento,'YYYY-MM-DD') AS validade,c.id AS contrato_id,c.plano,c.valor_mensal,c.estado,c.renovacao,c.limite_simultaneo,c.revisao,
        TO_CHAR(c.inicio,'YYYY-MM-DD') AS inicio_iso,TO_CHAR(c.pago_ate,'YYYY-MM-DD') AS pago_ate_iso,
        COALESCE((SELECT json_agg(v.placa ORDER BY v.id) FROM mensalista_veiculos v WHERE v.mensalista_id=m.id),'[]'::json) AS veiculos,
        COALESCE((SELECT SUM(b.total-b.pago) FROM mensalista_cobrancas b WHERE b.contrato_id=c.id AND b.estado IN ('aberta','parcial')),0) AS saldo_aberto,
        CASE WHEN c.estado='cancelado' THEN 'cancelado' WHEN c.estado='suspenso' OR NOT m.ativo THEN 'suspenso'
             WHEN COALESCE(c.pago_ate,m.vencimento) IS NULL THEN 'sem_pagamento' WHEN c.inicio > $1::date THEN 'a_iniciar'
             WHEN COALESCE(c.pago_ate,m.vencimento) < $1::date THEN 'vencido' WHEN COALESCE(c.pago_ate,m.vencimento)=$1::date THEN 'vence_hoje'
             WHEN COALESCE(c.pago_ate,m.vencimento) <= $1::date+2 THEN 'a_vencer' ELSE 'em_dia' END AS situacao
        FROM mensalistas m LEFT JOIN mensalista_contratos c ON c.mensalista_id=m.id`;
    async function list(req,exporting=false){
        const p=paging(req.query),params=[today()],where=[];
        const add=(condition,value)=>{params.push(value);where.push(condition.replace('?',`$${params.length}`));};
        if(req.query.q){if(String(req.query.q).length>120)fail('Busca muito longa');add("(placa ILIKE ? OR nome ILIKE $N OR cpf ILIKE $N OR EXISTS (SELECT 1 FROM mensalista_veiculos v WHERE v.mensalista_id=d.id AND v.placa ILIKE $N))",`%${req.query.q}%`);where[where.length-1]=where.at(-1).replaceAll('$N',`$${params.length}`);}
        if(req.query.status){const s=req.query.status;if(s==='ativo')where.push('ativo=true');else if(s==='inativo')where.push('ativo=false');else if(['em_dia','a_vencer','vence_hoje','vencido','sem_pagamento','suspenso','cancelado','a_iniciar'].includes(s))add('situacao=?',s);else fail('Situação inválida');}
        const cte=`WITH d AS (${dataset})`,clause=where.length?' WHERE '+where.join(' AND '):'';
        const summary=(await query(`${cte} SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE situacao='vencido')::int AS vencidos,COUNT(*) FILTER (WHERE situacao='vence_hoje')::int AS vence_hoje,COUNT(*) FILTER (WHERE situacao='a_vencer')::int AS a_vencer,COALESCE(SUM(saldo_aberto),0) AS saldo_aberto FROM d${clause}`,params)).rows[0];
        const rows=(await query(`${cte} SELECT * FROM d${clause} ORDER BY atualizado_em DESC,id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,exporting?20001:p.size,exporting?0:p.offset])).rows.map(row=>({...row,vencimento:row.pago_ate_iso||row.validade||null,inicio:row.inicio_iso}));
        return {success:true,dados:rows,resumo:summary,paginacao:pageInfo(p,summary.total)};
    }
    router.get('/mensalistas',handle(async(req,res)=>res.json(await list(req))));
    router.get('/mensalistas/avisos',handle(async(req,res)=>{
        const rows=(await query(`WITH d AS (${dataset}) SELECT id,nome,placa,COALESCE(pago_ate_iso,validade) AS vencimento,situacao FROM d WHERE situacao IN ('a_vencer','vence_hoje','vencido') ORDER BY CASE situacao WHEN 'vence_hoje' THEN 0 WHEN 'a_vencer' THEN 1 ELSE 2 END,COALESCE(pago_ate_iso,validade),id LIMIT 100`,[today()])).rows;
        res.json({success:true,dados:rows,data:today()});
    }));
    router.get('/mensalistas/exportar.csv',allow(...managers,'financeiro'),handle(async(req,res)=>{
        const data=await list(req,true);if(data.dados.length>20000)fail('Refine os filtros para exportar até 20 mil clientes',413);
        await tx(client=>audit(client,req.user,'mensalistas_exportacao',{filtros:req.query,registros:data.dados.length}));
        res.type('text/csv').attachment('mensalistas.csv').send(csvText([['Cliente','Placa principal','Veículos','Plano','Valor mensal','Pago até','Situação','Saldo aberto'],...data.dados.map(r=>[r.nome,r.placa,r.veiculos.join(', '),r.plano,r.valor_mensal,r.vencimento,r.situacao,r.saldo_aberto])]));
    }));
    async function save(req,res){
        const customer=customerInput(req.body);const terms=contractInput(req.body,today());
        if(req.body.vencimento)fail('A validade é atualizada pela quitação da cobrança. Para saldo legado, use regularização justificada.');
        const result=await tx(async client=>{
            await client.query('SELECT pg_advisory_xact_lock($1)',[743221908]);
            const old=req.params.id?await lockSubscription(client,req.params.id,clock(),timeZone):null;
            const changingState=old&&old.contract.estado!==terms.estado;
            const note=old?reason(req.body.motivo):'';
            if(old&&terms.inicio!==old.contract.inicio_iso)fail('O início do contrato fica preservado após o cadastro');
            if(old){
                const active=(await client.query("SELECT placa FROM historico WHERE status='ativo' AND mensalista=true AND (mensalista_id=$1 OR placa=ANY($2::text[]))",[old.customer.id,(await client.query('SELECT placa FROM mensalista_veiculos WHERE mensalista_id=$1',[old.customer.id])).rows.map(r=>r.placa)])).rows;
                if(active.some(r=>!customer.veiculos.includes(r.placa)))fail('Registre a saída antes de remover um veículo que está no pátio',409);
                if(active.length>terms.limite_simultaneo)fail('O limite não pode ser menor que os veículos atualmente no pátio',409);
                if(terms.estado==='cancelado'){
                    if((await client.query("SELECT id FROM mensalista_cobrancas WHERE contrato_id=$1 AND estado='parcial'",[old.contract.id])).rows.length)fail('Existe cobrança parcialmente recebida. Quite o saldo antes de cancelar o contrato.',409);
                    await client.query("UPDATE mensalista_cobrancas SET estado='cancelada',motivo_cancelamento=$1,cancelada_por=$2,atualizado_em=NOW() WHERE contrato_id=$3 AND estado='aberta'",[note,req.user.id,old.contract.id]);
                }
            }
            const collision=(await client.query('SELECT mensalista_id FROM mensalista_veiculos WHERE placa=ANY($1::text[]) AND ($2::bigint IS NULL OR mensalista_id<>$2)',[customer.veiculos,old?.customer.id||null])).rows;
            const primary=(await client.query('SELECT id FROM mensalistas WHERE placa=ANY($1::text[]) AND ($2::bigint IS NULL OR id<>$2)',[customer.veiculos,old?.customer.id||null])).rows;
            if(collision.length||primary.length)fail('Uma das placas já pertence a outro cliente',409);
            let id=old?.customer.id;
            if(old){
                await client.query('UPDATE mensalistas SET placa=$1,nome=$2,telefone=$3,cpf=$4,ativo=$5,atualizado_em=NOW() WHERE id=$6',[customer.placa,customer.nome,customer.telefone,customer.cpf,terms.estado==='ativo',id]);
                await client.query('UPDATE mensalista_contratos SET plano=$1,valor_mensal=$2,estado=$3,renovacao=$4,limite_simultaneo=$5,revisao=revisao+1,atualizado_em=NOW() WHERE id=$6',[terms.plano,terms.valor_mensal,terms.estado,terms.renovacao,terms.limite_simultaneo,old.contract.id]);
                await client.query('DELETE FROM mensalista_veiculos WHERE mensalista_id=$1',[id]);
            }else{
                id=(await client.query('INSERT INTO mensalistas (placa,nome,telefone,cpf,ativo) VALUES ($1,$2,$3,$4,$5) RETURNING id',[customer.placa,customer.nome,customer.telefone,customer.cpf,terms.estado==='ativo'])).rows[0].id;
                await client.query('INSERT INTO mensalista_contratos (mensalista_id,plano,valor_mensal,inicio,dia_base,estado,renovacao,limite_simultaneo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[id,terms.plano,terms.valor_mensal,terms.inicio,Number(terms.inicio.slice(8)),terms.estado,terms.renovacao,terms.limite_simultaneo]);
            }
            for(const plate of customer.veiculos)await client.query('INSERT INTO mensalista_veiculos (mensalista_id,placa) VALUES ($1,$2)',[id,plate]);
            await audit(client,req.user,old?'mensalista_contrato_alterado':'mensalista_contrato_criado',{mensalista_id:id,antes:old,depois:{...customer,...terms},motivo:note,alterou_situacao:Boolean(changingState)});
            return {id,...customer,...terms,vencimento:old?.contract.validade||null};
        });res.json({success:true,dados:result});
    }
    router.post('/mensalistas',allow(...managers),handle(save));
    router.put('/mensalistas/:id',allow(...managers),handle(save));
    router.patch('/mensalistas/:id/status',allow(...managers),handle(async(req,res)=>{
        const note=reason(req.body.motivo);if(!['ativo','suspenso','cancelado'].includes(req.body.estado))fail('Informe a situação do contrato');
        await tx(async client=>{
            const {customer,contract}=await lockSubscription(client,req.params.id,clock(),timeZone);
            if(req.body.estado==='cancelado'&&(await client.query("SELECT id FROM mensalista_cobrancas WHERE contrato_id=$1 AND estado IN ('aberta','parcial')",[contract.id])).rows.length)fail('Quite ou cancele a cobrança aberta antes de cancelar o contrato',409);
            await client.query('UPDATE mensalista_contratos SET estado=$1,revisao=revisao+1,atualizado_em=NOW() WHERE id=$2',[req.body.estado,contract.id]);
            await client.query('UPDATE mensalistas SET ativo=$1,atualizado_em=NOW() WHERE id=$2',[req.body.estado==='ativo',customer.id]);
            await audit(client,req.user,'mensalista_situacao',{mensalista_id:customer.id,antes:contract.estado,depois:req.body.estado,motivo:note});
        });res.json({success:true});
    }));
    router.post('/mensalistas/:id/regularizar-validade',allow(...managers),handle(async(req,res)=>{
        const note=reason(req.body.motivo),valid=req.body.pago_ate;if(civilDate(valid)!==valid)fail('Validade inválida');
        await tx(async client=>{
            const {customer,contract}=await lockSubscription(client,req.params.id,clock(),timeZone);
            if((await client.query("SELECT id FROM mensalista_cobrancas WHERE contrato_id=$1 AND estado<>'cancelada'",[contract.id])).rows.length)fail('A regularização de legado exige um contrato sem cobranças. Preserve a quitação e os recebimentos existentes.',409);
            if(valid<contract.inicio_iso)fail('A validade não pode anteceder o início do contrato');
            await client.query('UPDATE mensalista_contratos SET pago_ate=$1,dia_base=$2,revisao=revisao+1,atualizado_em=NOW() WHERE id=$3',[valid,Number(valid.slice(8)),contract.id]);
            await client.query('UPDATE mensalistas SET vencimento=$1,atualizado_em=NOW() WHERE id=$2',[valid,customer.id]);
            await audit(client,req.user,'mensalista_validade_legada',{mensalista_id:customer.id,antes:contract.validade,depois:valid,motivo:note,gera_receita:false});
        });res.json({success:true});
    }));
    router.post('/mensalistas/:id/cotacao',allow(...receiving),handle(async(req,res)=>{
        const result=await tx(async client=>{const {customer,contract}=await lockSubscription(client,req.params.id,clock(),timeZone);return monthlyQuote(client,customer,contract,req.body.meses==null?null:Number(req.body.meses),clock(),timeZone);});
        res.json({success:true,dados:result});
    }));
    router.post('/mensalistas/:id/cobrancas',allow(...receiving),handle(async(req,res)=>{
        const key=operationKey(req.body.operacao_id);
        const result=await tx(async client=>{
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[key]);
            const {customer,contract}=await lockSubscription(client,req.params.id,clock(),timeZone);
            const previous=(await client.query('SELECT id,contrato_id,meses,criada_por FROM mensalista_cobrancas WHERE chave=$1',[key])).rows[0];
            if(previous){if(String(previous.contrato_id)!==String(contract.id)||Number(previous.meses)!==Number(req.body.meses)||String(previous.criada_por)!==String(req.user.id))fail('Identificador já utilizado por outra cobrança',409);return previous.id;}
            if(contract.revisao!==req.body.revisao)fail('O contrato mudou. Atualize a cobrança.',409);
            const quote=await monthlyQuote(client,customer,contract,Number(req.body.meses),clock(),timeZone);
            const id=await createInvoice(client,quote,key,req.user);
            if(!quote.cobranca_id){await client.query('UPDATE mensalista_contratos SET revisao=revisao+1 WHERE id=$1',[contract.id]);await audit(client,req.user,'mensalista_cobranca_criada',{mensalista_id:customer.id,cobranca_id:id,...quote});}
            return id;
        });res.json({success:true,cobranca_id:result});
    }));
    router.post('/mensalistas/:id/cobrancas/:invoice/cancelar',allow(...managers),handle(async(req,res)=>{
        const note=reason(req.body.motivo);
        await tx(async client=>{
            const {contract}=await lockSubscription(client,req.params.id,clock(),timeZone);
            const row=(await client.query("SELECT * FROM mensalista_cobrancas WHERE id=$1 AND contrato_id=$2 FOR UPDATE",[req.params.invoice,contract.id])).rows[0];
            if(!row)fail('Cobrança não encontrada',404);if(row.estado==='cancelada')return;
            if(row.estado!=='aberta'||cents(row.pago)>0)fail('Não é possível cancelar cobrança com recebimento. O pagamento deve ser preservado.',409);
            await client.query("UPDATE mensalista_cobrancas SET estado='cancelada',motivo_cancelamento=$1,cancelada_por=$2,atualizado_em=NOW() WHERE id=$3",[note,req.user.id,row.id]);
            await client.query('UPDATE mensalista_contratos SET revisao=revisao+1 WHERE id=$1',[contract.id]);
            await audit(client,req.user,'mensalista_cobranca_cancelada',{mensalista_id:req.params.id,cobranca_id:row.id,motivo:note});
        });res.json({success:true});
    }));
    router.get('/mensalistas/:id/financeiro',handle(async(req,res)=>{
        const result=await tx(async client=>{
            const {customer,contract}=await lockSubscription(client,req.params.id,clock(),timeZone);
            const invoices=(await client.query(`SELECT ${invoiceColumns} FROM mensalista_cobrancas b WHERE contrato_id=$1 ORDER BY id DESC LIMIT 100`,[contract.id])).rows;
            const vehicles=(await client.query('SELECT placa FROM mensalista_veiculos WHERE mensalista_id=$1 ORDER BY id',[customer.id])).rows.map(r=>r.placa);
            return {cliente:customer,contrato:{...contract,situacao:subscriptionState(customer,contract,today())},veiculos:vehicles,cobrancas:invoices};
        });res.json({success:true,dados:result});
    }));
    router.get('/mensalistas/:id/pagamentos',handle(async(req,res)=>{
        const p=paging(req.query),id=req.params.id;if(!/^\d+$/.test(id))fail('Mensalista inválido');
        const count=(await query("SELECT COUNT(*)::int AS n FROM operacoes_financeiras WHERE tipo='mensalidade' AND referencia=$1",[id])).rows[0].n;
        const operations=(await query("SELECT chave,turno_id,usuario_id,criado_em,resposta->'comprovante' AS comprovante,cobranca_id FROM operacoes_financeiras WHERE tipo='mensalidade' AND referencia=$1 ORDER BY criado_em DESC,chave DESC LIMIT $2 OFFSET $3",[id,p.size,p.offset])).rows;
        const legacy=(await query("SELECT *,TO_CHAR(data_pagamento,'DD/MM/YYYY') AS data_pagamento,TO_CHAR(hora_pagamento,'HH24:MI:SS') AS hora_pagamento FROM caixa_movimentos WHERE origem='mensalidade' AND mensalista_id=$1 AND operacao_chave IS NULL ORDER BY id DESC LIMIT 100",[id])).rows;
        res.json({success:true,dados:legacy,recebimentos:operations,paginacao:pageInfo(p,count)});
    }));
    router.get('/mensalistas/:placa',handle(async(req,res)=>{
        const plate=normalizePlate(req.params.placa);if(!isValidPlate(plate))fail('Placa inválida');
        const rows=(await query(`WITH d AS (${dataset}) SELECT * FROM d WHERE placa=$2 OR veiculos::jsonb ? $2`,[today(),plate])).rows;
        if(rows.length!==1)fail('Mensalista não encontrado',404);const row=rows[0];res.json({success:true,dados:{...row,vencimento:row.pago_ate_iso||row.validade||null,inicio:row.inicio_iso}});
    }));
    return router;
}
