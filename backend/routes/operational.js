import express from 'express';
import {timingSafeEqual} from 'node:crypto';
import {audit,fail} from '../services/financial-domain.js';
import {decryptBundle} from '../services/backup-crypto.js';
import {schemaVersion} from '../services/database-initialization.js';
export function createOperationalRouter({service,query,tx,allow,ready,env,clock=()=>new Date()}){
    const router=express.Router(),publicRouter=express.Router();
    const handle=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(error){next(error);}};
    publicRouter.get('/ready',async(_req,res)=>{
        try{if(!await ready())throw Error('not_ready');await query('SELECT 1 AS ok');res.json({success:true,service:'estacionamento',status:'pronto'});}
        catch{res.set('Retry-After','2').status(503).json({success:false,service:'estacionamento',status:'banco_indisponivel'});}
    });
    publicRouter.get('/internal/manutencao',handle(async(req,res)=>{
        const secret=String(env.CRON_SECRET||''),given=String(req.headers.authorization||''),expected=`Bearer ${secret}`;
        if(secret.length<32||Buffer.byteLength(given)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(given),Buffer.from(expected)))return res.status(401).json({success:false,error:'Agendamento não autorizado'});
        if(env.VERCEL&&env.VERCEL_ENV!=='production')return res.status(404).json({success:false,error:'Agendamento disponível apenas em produção'});
        if(!await ready())return res.status(503).json({success:false,error:'Banco indisponível para manutenção'});
        res.json(await service.scheduled());
    }));
    router.get('/operacao/estado',handle(async(_req,res)=>res.json({success:true,dados:await service.state()})));
    router.get('/operacao/status',allow('administrador'),handle(async(_req,res)=>{
        const [state,backups,points,counts,manual]=await Promise.all([
            service.state(),query('SELECT id,origem,estado,arquivo,checksum,chave_id,tamanho,registros,verificado_em,erro_codigo,criado_em,concluido_em FROM backup_execucoes ORDER BY criado_em DESC LIMIT 50'),
            query('SELECT id,usuario_id,criado_em FROM operacao_restauracoes ORDER BY criado_em DESC LIMIT 3'),
            query("SELECT (SELECT COUNT(*)::int FROM historico WHERE status='ativo') AS patio,(SELECT COUNT(*)::int FROM caixa_turnos WHERE estado='aberto') AS caixas_abertos,(SELECT COUNT(*)::int FROM caixa_conferencias WHERE estado='pendente' AND substituida_em IS NULL) AS diferencas_pendentes"),
            query("SELECT criado_em,acao,usuario_nome FROM auditoria WHERE acao IN ('backup_export','backup_cifrado_export') ORDER BY criado_em DESC,id DESC LIMIT 1")
        ]);
        const verified=backups.rows.find(row=>row.estado==='concluido'&&row.arquivo&&row.verificado_em);
        const configuration=service.configuration();
        res.json({success:true,dados:{schema:schemaVersion,agora:clock().toISOString(),manutencao:state,backup:configuration,ultimo_backup:verified||null,ultimo_backup_manual:manual.rows[0]||null,backup_atrasado:configuration.automatico&&(!verified||clock()-new Date(verified.verificado_em)>36*3600000),execucoes:backups.rows,pontos_retorno:points.rows,operacao:counts.rows[0]}});
    }));
    router.post('/operacao/manutencao',allow('administrador'),handle(async(req,res)=>res.json(await service.setMaintenance(req.body.ativo,req.body.motivo,req.user))));
    router.get('/operacao/backup-manual',allow('administrador'),handle(async(req,res)=>{
        const bytes=await service.manualArchive(req.user);
        res.type('application/json').attachment(`backup-completo-cifrado-${clock().toISOString().replace(/[:.]/g,'-')}.json`).send(bytes);
    }));
    router.post('/operacao/backups',allow('administrador'),handle(async(req,res)=>res.json(await service.backup('manual',req.user))));
    router.get('/operacao/backups/:id/arquivo',allow('administrador'),handle(async(req,res)=>{
        const {bytes}=await service.archive(req.params.id);await tx(client=>audit(client,req.user,'backup_cifrado_download',{id:req.params.id}));
        res.type('application/json').attachment(`backup-cifrado-${req.params.id}.json`).send(bytes);
    }));
    router.post('/operacao/backups/:id/verificar',allow('administrador'),handle(async(req,res)=>{
        const {bytes,row}=await service.archive(req.params.id);if(row.estado==='executando')fail('Aguarde a conclusão do backup',409);
        decryptBundle(bytes,env.BACKUP_ENCRYPTION_KEY);
        await tx(async client=>{await client.query("UPDATE backup_execucoes SET estado='concluido',erro_codigo=NULL,verificado_em=$1 WHERE id=$2",[clock().toISOString(),row.id]);await audit(client,req.user,'backup_reverificado',{id:row.id});});res.json({success:true,verificado:true});
    }));
    router.post('/operacao/backups/:id/restaurar',allow('administrador'),handle(async(req,res)=>{
        if(req.body.confirmacao!=='RESTAURAR')fail('Confirme a restauração digitando RESTAURAR');
        const {bytes}=await service.archive(req.params.id),bundle=decryptBundle(bytes,env.BACKUP_ENCRYPTION_KEY);
        res.json(await service.restore(bundle.operacional,req.user,req.body.senha,req.session.hash));
    }));
    router.get('/operacao/restauracoes/:id/arquivo',allow('administrador'),handle(async(req,res)=>{
        const backup=await service.returnPoint(req.params.id);await tx(client=>audit(client,req.user,'ponto_retorno_download',{id:req.params.id}));
        res.json({success:true,dados:backup});
    }));
    router.get('/operacoes/:key',handle(async(req,res)=>{
        const row=await tx(async client=>{await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[req.params.key]);return (await client.query(req.query.grupo==='caixa'?'SELECT usuario_id,resposta FROM caixa_acoes WHERE chave=$1':'SELECT usuario_id,resposta FROM operacoes_financeiras WHERE chave=$1',[req.params.key])).rows[0];});
        if(!row)return res.status(404).json({success:false,error:'Operação ainda não confirmada no servidor'});
        if(String(row.usuario_id)!==String(req.user.id)&&!['administrador','supervisor','financeiro'].includes(req.user.perfil))fail('A operação pertence a outro usuário',403);
        res.json({success:true,dados:row.resposta});
    }));
    return {router,publicRouter};
}
