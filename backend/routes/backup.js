import express from 'express';
import {audit,fail} from '../services/financial-domain.js';
import {captureOperational,validateBackup,prepareOperational,recordCount} from '../services/backup-domain.js';
export function createBackupRouter({tx,allow,operations}){
    const router=express.Router(),handle=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(error){next(error);}};
    router.get('/backup',allow('administrador'),handle(async(req,res)=>{
        const data=await tx(async client=>{await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');const backup=await captureOperational(client);await audit(client,req.user,'backup_export',{registros:recordCount(backup)});return backup;});
        res.json({success:true,dados:data});
    }));
    router.post('/restore/validar',allow('administrador'),handle(async(req,res)=>{
        const backup=req.body.backup;validateBackup(backup);await tx(client=>prepareOperational(client,backup));
        res.json({success:true,dados:{versao:backup.versao,gerado_em:backup.gerado_em,registros:recordCount(backup),tabelas:Object.entries(backup.tabelas).map(([nome,rows])=>({nome,registros:rows.length}))}});
    }));
    router.post('/restore',allow('administrador'),handle(async(req,res)=>{
        if(req.body.confirmacao!=='RESTAURAR')fail('Confirme a restauração digitando RESTAURAR');
        res.json(await operations.restore(req.body.backup,req.user,req.body.senha,req.session.hash));
    }));
    return router;
}