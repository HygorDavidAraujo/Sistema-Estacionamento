import express from 'express';
import { createHash } from 'node:crypto';
import { audit, fail, cents, operationKey } from '../services/financial-domain.js';
import { lockShift, ownShift, visibleShift, isCashManager, reason, shiftSummary, dateRange } from '../services/cash-domain.js';

export function createCashRouter({query,tx,allow,timeZone='America/Sao_Paulo',clock=()=>new Date()}){
    const router=express.Router();
    const handle=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(error){next(error);}};
    const date=now=>new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
    async function company(client){const {rows}=await client.query("SELECT chave,valor FROM configuracoes WHERE chave LIKE '%estacionamento'");const data=Object.fromEntries(rows.map(row=>[row.chave,row.valor]));return {nome:data.nome_estacionamento||'Estacionamento',documento:data.documento_estacionamento||'',endereco:data.endereco_estacionamento||'',telefone:data.telefone_estacionamento||''};}
    async function action(req,name,work){
        const key=operationKey(req.body.operacao_id);const body={...req.body};delete body.operacao_id;
        const hash=createHash('sha256').update(JSON.stringify([name,req.params,body])).digest('hex');
        return tx(async client=>{
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[key]);
            const previous=(await client.query('SELECT * FROM caixa_acoes WHERE chave=$1',[key])).rows[0];
            if(previous){if(previous.requisicao_hash!==hash||String(previous.usuario_id)!==String(req.user.id))fail('Identificador já utilizado por outra operação',409);return previous.resposta;}
            await client.query('SELECT pg_advisory_xact_lock($1)',[743221906]);
            const result=await work(client,key);
            await client.query('INSERT INTO caixa_acoes (chave,acao,turno_id,usuario_id,requisicao_hash,resposta) VALUES ($1,$2,$3,$4,$5,$6)',[key,name,result.turno_id,req.user.id,hash,JSON.stringify(result)]);
            return result;
        });
    }
    async function current(req){
        return tx(async client=>{
            const shift=(await client.query("SELECT *,TO_CHAR(data_ref,'YYYY-MM-DD') AS data_iso FROM caixa_turnos WHERE estado='aberto' FOR UPDATE")).rows[0];
            const legacy=(await client.query("SELECT COUNT(*)::int AS n FROM caixa_turnos WHERE estado='legado' AND fechado_em IS NULL")).rows[0].n;
            const approvals=(await client.query("SELECT COUNT(*)::int AS n FROM caixa_conferencias c JOIN caixa_turnos t ON t.id=c.turno_id WHERE c.estado='pendente' AND c.substituida_em IS NULL AND ($1::boolean OR t.operador_id=$2)",[isCashManager(req.user)||req.user.perfil==='financeiro',req.user.id])).rows[0].n;
            if(!shift)return {success:true,dados:null,legados_abertos:isCashManager(req.user)?legacy:0,pendencias:approvals};
            const visible=ownShift(shift,req.user)||isCashManager(req.user)||req.user.perfil==='financeiro';
            return {success:true,dados:{...shift,pode_operar:ownShift(shift,req.user),pode_fechar:ownShift(shift,req.user)||isCashManager(req.user),resumo:visible?await shiftSummary(client,shift):null},legados_abertos:isCashManager(req.user)?legacy:0,pendencias:approvals};
        });
    }
    router.get('/caixa/turnos/atual',handle(async(req,res)=>res.json(await current(req))));
    router.get('/caixa/dashboard',handle(async(req,res)=>{
        const result=await current(req);
        if(result.dados&&!result.dados.resumo)fail('O caixa pertence a outro operador',403);
        res.json({success:true,dados:result.dados?.resumo||{total_recebido:0,total_dinheiro:0,total_credito:0,total_debito:0,total_pix:0,total_transacoes:0,fundo_inicial:0,saldo_esperado:0,sangrias:0,suprimentos:0},turno_id:result.dados?.id||null});
    }));
    router.post('/caixa/turnos/abrir',handle(async(req,res)=>{
        const fund=cents(req.body.fundo_inicial,'Fundo inicial');const note=reason(req.body.observacao,false);
        res.json(await action(req,'abertura',async(client,key)=>{
            if(!(await client.query('SELECT id FROM usuarios WHERE id=$1 AND ativo=true FOR SHARE',[req.user.id])).rows.length)fail('Usuário inativo',403);
            if((await client.query("SELECT id FROM caixa_turnos WHERE estado='aberto'")).rows.length)fail('Já existe um turno aberto. Encerre o atual antes da troca de operador.',409);
            const now=clock();const shift=(await client.query(`INSERT INTO caixa_turnos (data_ref,aberto_em,observacao_abertura,operador_id,operador_nome,fundo_inicial,estado)
                VALUES ($1,$2,$3,$4,$5,$6,'aberto') RETURNING *`,[date(now),now.toISOString(),note||null,req.user.id,req.user.nome,fund/100])).rows[0];
            const receipt={tipo:'abertura_caixa',numero:key,turno_id:shift.id,empresa:await company(client),operador:req.user.nome,emitido_em:now.toISOString(),fundo_inicial:fund/100,fuso:timeZone,observacao:note};
            await audit(client,req.user,'caixa_turno_abertura',{turno_id:shift.id,fundo_inicial:fund/100,operacao_id:key});
            return {success:true,turno_id:shift.id,dados:shift,comprovante:receipt};
        }));
    }));
    router.get('/caixa/turnos/:id/resumo',handle(async(req,res)=>{
        res.json(await tx(async client=>{
            const shift=(await client.query("SELECT *,TO_CHAR(data_ref,'YYYY-MM-DD') AS data_iso FROM caixa_turnos WHERE id=$1 FOR UPDATE",[req.params.id])).rows[0];
            if(!shift)fail('Turno não encontrado',404);visibleShift(shift,req.user);
            const summary=shift.estado==='aberto'?await shiftSummary(client,shift):null;
            const adjustments=(await client.query('SELECT * FROM caixa_ajustes WHERE turno_id=$1 ORDER BY id DESC',[shift.id])).rows;
            const versions=(await client.query('SELECT * FROM caixa_conferencias WHERE turno_id=$1 ORDER BY versao DESC',[shift.id])).rows;
            const opening=(await client.query("SELECT resposta->'comprovante' AS comprovante FROM caixa_acoes WHERE turno_id=$1 AND acao='abertura'",[shift.id])).rows[0]?.comprovante||null;
            return {success:true,dados:{turno:shift,resumo:summary,abertura:opening,ajustes:adjustments,conferencias:versions}};
        }));
    }));
    router.post('/caixa/ajustes',handle(async(req,res)=>{
        if(!['sangria','suprimento'].includes(req.body.tipo))fail('Escolha sangria ou suprimento');
        const value=cents(req.body.valor);if(value===0)fail('Informe um valor maior que zero');const note=reason(req.body.motivo);
        res.json(await action(req,'ajuste',async(client,key)=>{
            const shift=await lockShift(client,req.body.turno_id,req.user,{own:false});
            const summary=await shiftSummary(client,shift);
            if(req.body.tipo==='sangria' && value>cents(summary.saldo_esperado))fail('Sangria maior que o dinheiro disponível no turno',409);
            const now=clock();const receipt={tipo:'movimento_caixa',movimento:req.body.tipo,numero:key,turno_id:shift.id,empresa:await company(client),operador:req.user.nome,responsavel:shift.operador_nome,emitido_em:now.toISOString(),total:value/100,observacao:note,fuso:timeZone};
            await client.query('INSERT INTO caixa_ajustes (turno_id,tipo,valor,motivo,usuario_id,usuario_nome,comprovante,criado_em) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[shift.id,req.body.tipo,value/100,note,req.user.id,req.user.nome,JSON.stringify(receipt),now.toISOString()]);
            await client.query('UPDATE caixa_turnos SET revisao=revisao+1 WHERE id=$1',[shift.id]);
            await audit(client,req.user,`caixa_${req.body.tipo}`,{turno_id:shift.id,valor:value/100,motivo:note,operacao_id:key});
            return {success:true,turno_id:shift.id,comprovante:receipt};
        }));
    }));
    const close=handle(async(req,res)=>{
        if(!Number.isInteger(req.body.revisao)||req.body.revisao<0)fail('Atualize o resumo do turno antes de fechar');
        const counted={};for(const field of ['dinheiro','credito','debito','pix'])counted[field]=cents(req.body.contagem?.[field],`Contagem de ${field}`)/100;
        res.json(await action(req,'fechamento',async(client,key)=>{
            const shift=await lockShift(client,req.body.turno_id,req.user,{own:false});
            if(shift.revisao!==req.body.revisao)fail('O turno recebeu novos movimentos. Atualize o resumo e confira novamente.',409);
            const summary=await shiftSummary(client,shift);
            const differences={dinheiro:(cents(counted.dinheiro)-cents(summary.saldo_esperado))/100,credito:(cents(counted.credito)-cents(summary.total_credito))/100,debito:(cents(counted.debito)-cents(summary.total_debito))/100,pix:(cents(counted.pix)-cents(summary.total_pix))/100};
            const divergent=Object.values(differences).some(value=>value!==0);
            const note=reason(req.body.motivo,divergent||!ownShift(shift,req.user));
            const version=Number((await client.query('SELECT COALESCE(MAX(versao),0)::int AS v FROM caixa_conferencias WHERE turno_id=$1',[shift.id])).rows[0].v)+1;
            const now=clock();const state=divergent?'pendente':'aprovado';
            const patio=(await client.query("SELECT COUNT(*)::int AS n FROM historico WHERE status='ativo'")).rows[0].n;
            const receipt={tipo:'fechamento_caixa',numero:key,turno_id:shift.id,versao:version,empresa:await company(client),operador:req.user.nome,responsavel:shift.operador_nome,aberto_em:shift.aberto_em,emitido_em:now.toISOString(),resumo:summary,contagem:counted,diferencas:differences,situacao:divergent?'Aguardando aprovação':'Conferido sem diferença',veiculos_no_patio:patio,observacao:note,fuso:timeZone};
            const conference=(await client.query(`INSERT INTO caixa_conferencias (turno_id,versao,resumo,contagem,diferencas,motivo,responsavel_id,responsavel_nome,estado,aprovado_por,aprovado_nome,aprovado_em,comprovante,criado_em)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,[shift.id,version,JSON.stringify(summary),JSON.stringify(counted),JSON.stringify(differences),note||null,req.user.id,req.user.nome,state,divergent?null:req.user.id,divergent?null:req.user.nome,divergent?null:now.toISOString(),JSON.stringify(receipt),now.toISOString()])).rows[0];
            await client.query('UPDATE caixa_turnos SET estado=$1,fechado_em=$2,observacao_fechamento=$3,ultima_conferencia_id=$4 WHERE id=$5',[divergent?'aguardando_aprovacao':'fechado',now.toISOString(),note||null,conference.id,shift.id]);
            await audit(client,req.user,'caixa_turno_fechamento',{turno_id:shift.id,conferencia_id:conference.id,versao:version,resumo:summary,contagem:counted,diferencas:differences,motivo:note});
            return {success:true,turno_id:shift.id,conferencia_id:conference.id,estado:divergent?'aguardando_aprovacao':'fechado',comprovante:receipt};
        }));
    });
    router.post('/caixa/turnos/fechar',close);
    router.post('/caixa/fechamento',close);
    router.post('/caixa/turnos/:id/reabrir',allow('supervisor','administrador'),handle(async(req,res)=>{
        const note=reason(req.body.motivo);
        res.json(await action(req,'reabertura',async(client)=>{
            const shift=await lockShift(client,req.params.id,req.user,{own:false,open:false});
            if(shift.estado==='aberto')fail('O turno já está aberto',409);
            if((await client.query("SELECT id FROM caixa_turnos WHERE estado='aberto'")).rows.length)fail('Encerre o turno atual antes de reabrir um anterior',409);
            const user=(await client.query('SELECT ativo FROM usuarios WHERE id=$1 FOR SHARE',[shift.operador_id])).rows[0];
            if(!user?.ativo)fail('O responsável pelo turno está inativo',409);
            await client.query('UPDATE caixa_conferencias SET substituida_em=$1 WHERE id=$2',[clock().toISOString(),shift.ultima_conferencia_id]);
            await client.query("UPDATE caixa_turnos SET estado='aberto',fechado_em=NULL,revisao=revisao+1 WHERE id=$1",[shift.id]);
            await audit(client,req.user,'caixa_turno_reabertura',{turno_id:shift.id,conferencia_anterior:shift.ultima_conferencia_id,motivo:note});
            return {success:true,turno_id:shift.id};
        }));
    }));
    router.post('/caixa/conferencias/:id/aprovar',allow('supervisor','administrador'),handle(async(req,res)=>{
        const note=reason(req.body.motivo);
        res.json(await action(req,'aprovacao',async(client)=>{
            const initial=(await client.query('SELECT turno_id FROM caixa_conferencias WHERE id=$1',[req.params.id])).rows[0];if(!initial)fail('Conferência não encontrada',404);
            const shift=await lockShift(client,initial.turno_id,req.user,{own:false,open:false});
            const conference=(await client.query('SELECT * FROM caixa_conferencias WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
            if(conference.estado!=='pendente'||conference.substituida_em||String(shift.ultima_conferencia_id)!==String(conference.id)||shift.estado!=='aguardando_aprovacao')fail('Esta conferência não está pendente',409);
            await client.query("UPDATE caixa_conferencias SET estado='aprovado',aprovado_por=$1,aprovado_nome=$2,aprovado_em=$3,motivo_aprovacao=$4 WHERE id=$5",[req.user.id,req.user.nome,clock().toISOString(),note,conference.id]);
            await client.query("UPDATE caixa_turnos SET estado='fechado' WHERE id=$1",[shift.id]);
            await audit(client,req.user,'caixa_divergencia_aprovada',{turno_id:shift.id,conferencia_id:conference.id,diferencas:conference.diferencas,motivo:note});
            return {success:true,turno_id:shift.id};
        }));
    }));
    router.post('/caixa/turnos/:id/encerrar-legado',allow('supervisor','administrador'),handle(async(req,res)=>{
        const note=reason(req.body.motivo);
        res.json(await action(req,'encerramento_legado',async(client)=>{
            const shift=(await client.query("SELECT * FROM caixa_turnos WHERE id=$1 AND estado='legado' AND fechado_em IS NULL FOR UPDATE",[req.params.id])).rows[0];if(!shift)fail('Turno legado aberto não encontrado',409);
            await client.query('UPDATE caixa_turnos SET fechado_em=$1,observacao_fechamento=$2 WHERE id=$3',[clock().toISOString(),note,shift.id]);
            await audit(client,req.user,'caixa_legado_encerrado',{turno_id:shift.id,motivo:note});return {success:true,turno_id:shift.id};
        }));
    }));
    router.get('/caixa/turnos',handle(async(req,res)=>{
        const range=dateRange(req.query);const params=[];let where=' WHERE 1=1';
        if(!isCashManager(req.user)&&req.user.perfil!=='financeiro'){params.push(req.user.id);where+=` AND operador_id=$${params.length}`;}
        if(range.dataInicio){params.push(range.dataInicio);where+=` AND data_ref >= $${params.length}`;}if(range.dataFim){params.push(range.dataFim);where+=` AND data_ref <= $${params.length}`;}
        const rows=(await query(`SELECT *,TO_CHAR(data_ref,'YYYY-MM-DD') AS data_iso FROM caixa_turnos${where} ORDER BY id DESC LIMIT 200`,params)).rows;
        res.json({success:true,dados:rows});
    }));
    router.get('/caixa/fechamentos',handle(async(req,res)=>{
        const range=dateRange(req.query);const params=[];let where=' WHERE 1=1';
        if(!isCashManager(req.user)&&req.user.perfil!=='financeiro'){params.push(req.user.id);where+=` AND t.operador_id=$${params.length}`;}
        if(range.dataInicio){params.push(range.dataInicio);where+=` AND t.data_ref >= $${params.length}`;}if(range.dataFim){params.push(range.dataFim);where+=` AND t.data_ref <= $${params.length}`;}
        const rows=(await query(`SELECT c.*,t.operador_nome,t.estado AS turno_estado,TO_CHAR(t.data_ref,'YYYY-MM-DD') AS data_ref FROM caixa_conferencias c JOIN caixa_turnos t ON t.id=c.turno_id${where} ORDER BY c.id DESC LIMIT 200`,params)).rows;
        const legacy=isCashManager(req.user)||req.user.perfil==='financeiro'?(await query("SELECT *,TO_CHAR(data_ref,'YYYY-MM-DD') AS data_iso FROM caixa_fechamentos WHERE ($1::date IS NULL OR data_ref >= $1) AND ($2::date IS NULL OR data_ref <= $2) ORDER BY data_ref DESC LIMIT 100",[range.dataInicio||null,range.dataFim||null])).rows:[];
        res.json({success:true,dados:rows,legados:legacy});
    }));
    router.get('/caixa/consolidado',allow('supervisor','financeiro','administrador'),handle(async(req,res)=>{
        const range=dateRange(req.query);const start=range.dataInicio||date(clock()),end=range.dataFim||start;
        const rows=(await query(`SELECT c.resumo,c.contagem,c.diferencas,c.estado FROM caixa_conferencias c JOIN caixa_turnos t ON t.ultima_conferencia_id=c.id
            WHERE c.substituida_em IS NULL AND t.estado IN ('fechado','aguardando_aprovacao') AND t.data_ref BETWEEN $1 AND $2`,[start,end])).rows;
        const result={turnos:rows.length,pendentes:0,receita:0,dinheiro_esperado:0,dinheiro_contado:0,diferenca_dinheiro:0};
        for(const row of rows){result.pendentes+=row.estado==='pendente'?1:0;result.receita+=cents(row.resumo.total_recebido);result.dinheiro_esperado+=cents(row.resumo.saldo_esperado);result.dinheiro_contado+=cents(row.contagem.dinheiro);result.diferenca_dinheiro+=Math.round(row.diferencas.dinheiro*100);}
        for(const key of ['receita','dinheiro_esperado','dinheiro_contado','diferenca_dinheiro'])result[key]/=100;
        res.json({success:true,dados:result,dataInicio:start,dataFim:end,criterio:'Data operacional de abertura do turno'});
    }));
    router.get('/caixa/comprovantes/:key',handle(async(req,res)=>{
        const row=(await query('SELECT a.resposta,t.operador_id FROM caixa_acoes a JOIN caixa_turnos t ON t.id=a.turno_id WHERE a.chave=$1',[req.params.key])).rows[0];
        if(!row?.resposta?.comprovante)fail('Comprovante não encontrado',404);visibleShift(row,req.user);res.json({success:true,dados:row.resposta.comprovante});
    }));
    return router;
}
