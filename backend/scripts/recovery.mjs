import '../env.js';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {decryptBundle,maxArchiveBytes} from '../services/backup-crypto.js';
import {recoverEmptyDatabase} from '../services/full-recovery.js';
const [action,file,output]=process.argv.slice(2);
try{
    if(!['verificar','exportar-operacional','restaurar-banco-vazio'].includes(action)||!file)throw Error('Uso: node scripts/recovery.mjs verificar|exportar-operacional|restaurar-banco-vazio arquivo.json [saida.json]');
    const bytes=await readFile(resolve(file));if(bytes.length>maxArchiveBytes)throw Error('Arquivo supera o limite de recuperação');
    const bundle=decryptBundle(bytes,process.env.BACKUP_ENCRYPTION_KEY);
    if(action==='verificar')console.log(JSON.stringify({integro:true,gerado_em:bundle.operacional.gerado_em,usuarios:bundle.usuarios.length,tabelas:Object.keys(bundle.operacional.tabelas).length}));
    else if(action==='exportar-operacional'){
        if(!output)throw Error('Informe o caminho do arquivo operacional de saída');
        await writeFile(resolve(output),JSON.stringify(bundle.operacional),{flag:'wx',mode:0o600});console.log('Arquivo operacional exportado. As credenciais não foram incluídas.');
    }else{
        const target=process.env.RECOVERY_DATABASE_URL;
        if(!target||process.env.RECOVERY_CONFIRM!=='BANCO_VAZIO')throw Error('Defina RECOVERY_DATABASE_URL e RECOVERY_CONFIRM=BANCO_VAZIO para um banco separado e vazio');
        if(target===process.env.DATABASE_URL)throw Error('O destino deve ser diferente do DATABASE_URL operacional');
        process.env.DATABASE_URL=target;
        const db=await import('../db.js');try{await recoverEmptyDatabase(db,bundle);console.log('Recuperação integral concluída em manutenção. Confira os dados antes de liberar a operação.');}finally{await db.close();}
    }
}catch(error){console.error(error.status?error.message:'Não foi possível executar a recuperação. Confira os argumentos, a chave e o banco vazio de destino.');process.exitCode=1;}
