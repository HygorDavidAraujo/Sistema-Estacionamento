import {randomUUID} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {audit,fail} from './financial-domain.js';
import {reason} from './cash-domain.js';
import {verifyPassword} from './auth.js';
import {captureOperational,applyOperational,validateBackup,recordCount,tables,operationLock} from './backup-domain.js';
import {encryptBundle,decryptBundle,sha256,encryptionKey,maxBackupBytes} from './backup-crypto.js';
import {createBackupStorage} from './backup-storage.js';
export function createOperationalService({query,tx,env,clock=()=>new Date(),storage=createBackupStorage(env)}){
    const system={id:null,nome:'Agendamento automático',perfil:'sistema'};
    function configuration(){
        const key=/^[a-f\d]{64}$/i.test(env.BACKUP_ENCRYPTION_KEY||''),store=storage.configured(),cron=String(env.CRON_SECRET||'').length>=32;
        return {modo:store?'externo':'manual',armazenamento:store,chave:key,agendamento:cron,configurado:key&&store,automatico:key&&store&&cron&&env.BACKUP_AUTOMATIC_ENABLED==='true'};
    }
    async function state(){return (await query('SELECT manutencao,motivo,usuario_nome,atualizado_em FROM operacao_estado WHERE id=1')).rows[0];}
    async function setMaintenance(active,note,user){
        if(typeof active!=='boolean')fail('Situação de manutenção inválida');note=reason(note);
        return tx(async client=>{
            await client.query('SELECT pg_advisory_xact_lock($1)',[operationLock]);
            await client.query('UPDATE operacao_estado SET manutencao=$1,motivo=$2,usuario_id=$3,usuario_nome=$4,atualizado_em=$5 WHERE id=1',[active,note,user.id,user.nome,clock().toISOString()]);
            await audit(client,user,active?'manutencao_iniciada':'manutencao_encerrada',{motivo:note});return {success:true,manutencao:active};
        });
    }
    async function cleanup(){return tx(async client=>{
        const count=async sql=>(await client.query(sql)).rowCount||0;
        return {sessoes:await count('DELETE FROM sessoes WHERE expira_em<=NOW()'),cotacoes:await count('DELETE FROM cotacoes_saida WHERE expira_em<NOW()'),cache:await count("DELETE FROM veiculos_cache WHERE expira_em<NOW()-INTERVAL '30 days'")};
    });}
    async function captureBundle(){return tx(async client=>{
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await client.query('SELECT pg_advisory_xact_lock_shared($1)',[operationLock]);
        const operacional=await captureOperational(client,clock());
        const usuarios=(await client.query('SELECT id,login,nome,perfil,senha_hash,ativo,criado_em,atualizado_em FROM usuarios ORDER BY id')).rows;
        const recuperacoes=(await client.query('SELECT token_hash,usuario_id,criado_em FROM auth_recuperacoes ORDER BY token_hash')).rows;
        return {formato:'estacionamento-recuperacao',versao:1,operacional,usuarios,recuperacoes,checksum_usuarios:sha256(JSON.stringify(usuarios))};
    });}
    async function manualArchive(user){
        encryptionKey(env.BACKUP_ENCRYPTION_KEY);
        const bundle=await captureBundle(),bytes=encryptBundle(bundle,env.BACKUP_ENCRYPTION_KEY,clock());
        decryptBundle(bytes,env.BACKUP_ENCRYPTION_KEY);
        await tx(client=>audit(client,user,'backup_cifrado_export',{checksum:sha256(bytes),tamanho:bytes.length,registros:recordCount(bundle.operacional),destino:'download_manual'}));
        return bytes;
    }
    async function backup(origin='manual',user=system){
        if(!configuration().configurado)fail('Configure o armazenamento privado e a chave de backup no Vercel antes de gerar a cópia externa.',503);
        encryptionKey(env.BACKUP_ENCRYPTION_KEY);
        const now=clock(),schedule=origin==='agendamento'?`diario:${now.toISOString().slice(0,10)}`:null;
        const claim=await tx(async client=>{
            const lock=(await client.query('SELECT * FROM operacao_estado WHERE id=1 FOR UPDATE')).rows[0];
            if(lock.backup_lease_ate&&new Date(lock.backup_lease_ate)>now)fail('Já existe backup em processamento. Aguarde a conclusão.',409);
            if(lock.backup_lease_id)await client.query("UPDATE backup_execucoes SET estado='falhou',erro_codigo='EXECUCAO_INTERROMPIDA',concluido_em=$1 WHERE id=$2 AND estado='executando'",[now.toISOString(),lock.backup_lease_id]);
            let previous=schedule?(await client.query('SELECT * FROM backup_execucoes WHERE chave_agendamento=$1',[schedule])).rows[0]:null;
            if(previous?.estado==='concluido')return {id:previous.id,repetido:true};
            const id=previous?.id||randomUUID();
            if(previous)await client.query("UPDATE backup_execucoes SET estado='executando',erro_codigo=NULL,concluido_em=NULL WHERE id=$1",[id]);
            else await client.query("INSERT INTO backup_execucoes (id,chave_agendamento,origem,estado,criado_em) VALUES ($1,$2,$3,'executando',$4)",[id,schedule,origin,now.toISOString()]);
            await client.query('UPDATE operacao_estado SET backup_lease_id=$1,backup_lease_ate=$2 WHERE id=1',[id,new Date(now.getTime()+15*60000).toISOString()]);
            return {id};
        });
        if(claim.repetido)return {success:true,...claim};
        const id=claim.id;let path;
        try{
            const bundle=await captureBundle(),bytes=encryptBundle(bundle,env.BACKUP_ENCRYPTION_KEY,now),checksum=sha256(bytes);
            path=await storage.write(`parking-backups/v1/${now.toISOString().slice(0,10)}/${id}-${randomUUID()}.json`,bytes);
            await query('UPDATE backup_execucoes SET arquivo=$1,checksum=$2,chave_id=$3,tamanho=$4,registros=$5 WHERE id=$6',[path,checksum,sha256(encryptionKey(env.BACKUP_ENCRYPTION_KEY)).slice(0,16),bytes.length,recordCount(bundle.operacional),id]);
            const stored=await storage.read(path);if(sha256(stored)!==checksum)fail('A cópia externa não confere com o arquivo enviado');
            const verified=decryptBundle(stored,env.BACKUP_ENCRYPTION_KEY);if(verified.operacional.checksum!==bundle.operacional.checksum)fail('Verificação de integridade do backup falhou');
            await tx(async client=>{
                await client.query("UPDATE backup_execucoes SET estado='concluido',verificado_em=$1,concluido_em=$1 WHERE id=$2",[clock().toISOString(),id]);
                await client.query('UPDATE operacao_estado SET backup_lease_id=NULL,backup_lease_ate=NULL WHERE id=1 AND backup_lease_id=$1',[id]);
                await audit(client,user,'backup_externo_verificado',{id,checksum,tamanho:bytes.length,registros:recordCount(bundle.operacional)});
            });
            // Só remover cópias antigas após confirmar a nova; preservar ao menos as três mais recentes.
            const retention=Math.max(7,Math.min(Number(env.BACKUP_RETENTION_DAYS)||30,365));
            try{const old=(await query("SELECT id,arquivo FROM backup_execucoes WHERE estado='concluido' AND verificado_em IS NOT NULL AND criado_em<$1 AND id NOT IN (SELECT id FROM backup_execucoes WHERE estado='concluido' ORDER BY criado_em DESC LIMIT 3)",[new Date(now.getTime()-retention*86400000).toISOString()])).rows;
                for(const row of old){if(!row.arquivo?.startsWith('parking-backups/v1/'))continue;try{await storage.remove(row.arquivo);await query('UPDATE backup_execucoes SET arquivo=NULL WHERE id=$1',[row.id]);}catch{console.error('[BACK] Retenção de backup pendente:',row.id);}}
            }catch{console.error('[BACK] A cópia está verificada; a retenção será conferida na próxima execução.');}
            return {success:true,id,verificado:true,tamanho:bytes.length};
        }catch(error){
            await tx(async client=>{await client.query("UPDATE backup_execucoes SET estado='falhou',erro_codigo=$1,concluido_em=$2 WHERE id=$3",[String(error.code||error.name||'BACKUP_FAILED').slice(0,100),clock().toISOString(),id]);await client.query('UPDATE operacao_estado SET backup_lease_id=NULL,backup_lease_ate=NULL WHERE id=1 AND backup_lease_id=$1',[id]);}).catch(()=>{});
            console.error('[BACK] Falha no backup externo:',{id,codigo:error.code||error.name});fail('Não foi possível concluir e verificar o backup externo. Consulte o diagnóstico e tente novamente.',503);
        }
    }
    async function archive(id){
        const row=(await query('SELECT * FROM backup_execucoes WHERE id=$1 AND arquivo IS NOT NULL',[id])).rows[0];if(!row)fail('Arquivo não disponível',404);
        const bytes=await storage.read(row.arquivo);if(sha256(bytes)!==row.checksum)fail('Integridade do arquivo externo inválida');return {bytes,row};
    }
    async function restore(backup,user,password,sessionHash){
        validateBackup(backup);
        return tx(async client=>{
            await client.query('SELECT pg_advisory_xact_lock($1)',[operationLock]);
            const current=(await client.query('SELECT senha_hash FROM usuarios WHERE id=$1 FOR UPDATE',[user.id])).rows[0];
            if(!await verifyPassword(password,current?.senha_hash))fail('Senha inválida',403);
            if(!(await client.query('SELECT manutencao FROM operacao_estado WHERE id=1')).rows[0].manutencao)fail('Ative a manutenção antes de restaurar. Os atendimentos serão suspensos durante a conferência.',409);
            await client.query(`LOCK TABLE ${tables.join(',')} IN ACCESS EXCLUSIVE MODE`);
            const safety=await captureOperational(client,clock()),raw=Buffer.from(JSON.stringify(safety));if(raw.length>maxBackupBytes)fail('A cópia de retorno excede o limite da restauração pela interface',413);
            const id=randomUUID();await client.query('INSERT INTO operacao_restauracoes (id,snapshot,checksum,usuario_id,criado_em) VALUES ($1,$2,$3,$4,$5)',[id,gzipSync(raw),safety.checksum,user.id,clock().toISOString()]);
            await applyOperational(client,backup);
            await client.query('DELETE FROM sessoes WHERE token_hash<>$1',[sessionHash||'']);
            await client.query('DELETE FROM operacao_restauracoes WHERE id NOT IN (SELECT id FROM operacao_restauracoes ORDER BY criado_em DESC,id DESC LIMIT 3)');
            await audit(client,user,'backup_restore',{gerado_em:backup.gerado_em,checksum:backup.checksum,ponto_retorno:id,manutencao_mantida:true});
            return {success:true,ponto_retorno:id,manutencao:true,mensagem:'Dados restaurados. Confira os valores e o pátio antes de encerrar a manutenção.'};
        });
    }
    async function returnPoint(id){const row=(await query('SELECT snapshot,checksum FROM operacao_restauracoes WHERE id=$1',[id])).rows[0];if(!row)fail('Ponto de retorno não encontrado',404);const backup=JSON.parse(gunzipSync(row.snapshot,{maxOutputLength:maxBackupBytes}).toString('utf8'));validateBackup(backup);if(backup.checksum!==row.checksum)fail('Ponto de retorno inválido');return backup;}
    async function scheduled(){
        const limpeza=await cleanup();if((await state()).manutencao)return {success:true,limpeza,backup:'adiado_por_manutencao'};
        if(!configuration().automatico)return {success:true,limpeza,backup:'nao_configurado_ou_desativado'};
        return {success:true,limpeza,backup:await backup('agendamento')};
    }
    return {configuration,state,setMaintenance,cleanup,manualArchive,backup,archive,restore,returnPoint,scheduled};
}
