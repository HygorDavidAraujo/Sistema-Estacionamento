import {put,get,del} from '@vercel/blob';
import {fail} from './financial-domain.js';
import {maxArchiveBytes} from './backup-crypto.js';
export function createBackupStorage(env){
    const options=()=>({...env.BLOB_READ_WRITE_TOKEN?{token:env.BLOB_READ_WRITE_TOKEN}:{},...env.BLOB_STORE_ID?{storeId:env.BLOB_STORE_ID}:{},abortSignal:AbortSignal.timeout(20000)});
    return {
        configured:()=>Boolean(env.BLOB_READ_WRITE_TOKEN||env.BLOB_STORE_ID),
        async write(path,bytes){const result=await put(path,bytes,{...options(),access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:'application/json'});return result.pathname;},
        async read(path){
            const result=await get(path,{...options(),access:'private',useCache:false});if(result?.statusCode!==200)fail('Backup externo não encontrado',404);
            const reader=result.stream.getReader(),chunks=[];let size=0;
            try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxArchiveBytes)fail('Arquivo externo excede o limite',413);chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
            return Buffer.concat(chunks);
        },
        async remove(path){await del(path,options());}
    };
}
