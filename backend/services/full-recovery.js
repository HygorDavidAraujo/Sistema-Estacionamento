import {fail,audit} from './financial-domain.js';
import {validateRecoveryBundle} from './backup-crypto.js';
import {applyOperational,tables,operationLock} from './backup-domain.js';
export async function recoverEmptyDatabase(db,bundle){
    validateRecoveryBundle(bundle);await db.initDb();
    return db.tx(async client=>{
        await client.query('SELECT pg_advisory_xact_lock($1)',[operationLock]);
        await client.query('LOCK TABLE usuarios IN EXCLUSIVE MODE');
        if((await client.query('SELECT id FROM usuarios LIMIT 1')).rows.length)fail('A recuperação integral exige banco sem usuários. O banco existente não foi substituído.',409);
        for(const table of tables.filter(t=>t!=='configuracoes'))if((await client.query(`SELECT 1 FROM ${table} LIMIT 1`)).rows.length)fail('O banco de destino contém dados operacionais. Use um banco de recuperação vazio.',409);
        await client.query('INSERT INTO usuarios SELECT * FROM json_populate_recordset(NULL::usuarios,$1::json)',[JSON.stringify(bundle.usuarios)]);
        await client.query("SELECT setval(pg_get_serial_sequence('usuarios','id'),(SELECT MAX(id) FROM usuarios),true)");
        await applyOperational(client,bundle.operacional);
        for(const row of bundle.recuperacoes||[])await client.query('INSERT INTO auth_recuperacoes (token_hash,usuario_id,criado_em) VALUES ($1,$2,$3)',[row.token_hash,row.usuario_id,row.criado_em]);
        await client.query('DELETE FROM sessoes');
        await client.query("UPDATE operacao_estado SET manutencao=true,motivo='Recuperação integral: conferir pátio e recebimentos antes de liberar',atualizado_em=NOW() WHERE id=1");
        await audit(client,{id:null,nome:'Recuperação integral'},'recuperacao_integral',{checksum:bundle.operacional.checksum,usuarios:bundle.usuarios.length,sessoes_restauradas:0});
        return {success:true,usuarios:bundle.usuarios.length,manutencao:true};
    });
}
