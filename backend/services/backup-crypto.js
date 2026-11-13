import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {fail} from './financial-domain.js';
import {validateBackup} from './backup-domain.js';
export const maxBackupBytes=64*1024*1024,maxArchiveBytes=96*1024*1024;
export const sha256=value=>createHash('sha256').update(value).digest('hex');
export function encryptionKey(value){if(typeof value!=='string'||!/^[a-f\d]{64}$/i.test(value))fail('Configure BACKUP_ENCRYPTION_KEY com 64 caracteres hexadecimais',503);return Buffer.from(value,'hex');}
export function encryptBundle(bundle,keyText,now=new Date()){
    const key=encryptionKey(keyText),raw=Buffer.from(JSON.stringify(bundle));if(raw.length>maxBackupBytes)fail('Backup supera o limite de 64 MB. Use a recuperação nativa do PostgreSQL.',413);
    const meta={formato:'estacionamento-backup-cifrado',versao:1,cifra:'AES-256-GCM',chave_id:sha256(key).slice(0,16),gerado_em:now.toISOString()},iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
    cipher.setAAD(Buffer.from(JSON.stringify(meta)));const encrypted=Buffer.concat([cipher.update(gzipSync(raw)),cipher.final()]);
    return Buffer.from(JSON.stringify({...meta,nonce:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),dados:encrypted.toString('base64')}));
}
export function decryptBundle(bytes,keyText){
    if(bytes.length>maxArchiveBytes)fail('Arquivo de backup excede o limite',413);
    try{
        const key=encryptionKey(keyText),archive=JSON.parse(bytes.toString('utf8'));
        if(archive.formato!=='estacionamento-backup-cifrado'||archive.versao!==1||archive.cifra!=='AES-256-GCM'||archive.chave_id!==sha256(key).slice(0,16))throw Error('format');
        const {formato,versao,cifra,chave_id,gerado_em}=archive,iv=Buffer.from(archive.nonce,'base64'),tag=Buffer.from(archive.tag,'base64');if(iv.length!==12||tag.length!==16)throw Error('length');
        const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from(JSON.stringify({formato,versao,cifra,chave_id,gerado_em})));decipher.setAuthTag(tag);
        const compressed=Buffer.concat([decipher.update(Buffer.from(archive.dados,'base64')),decipher.final()]);
        const bundle=JSON.parse(gunzipSync(compressed,{maxOutputLength:maxBackupBytes}).toString('utf8'));validateRecoveryBundle(bundle);return bundle;
    }catch(error){if(error.status===503)throw error;fail('Arquivo inválido, adulterado ou chave de backup incorreta');}
}
export function validateRecoveryBundle(bundle){
    if(bundle?.formato!=='estacionamento-recuperacao'||bundle.versao!==1||!Array.isArray(bundle.usuarios)||!bundle.usuarios.length||bundle.usuarios.length>10000)fail('Pacote de recuperação inválido');
    validateBackup(bundle.operacional);
    const allowed=['id','login','nome','perfil','senha_hash','ativo','criado_em','atualizado_em'];
    const ids=new Set(),logins=new Set();
    for(const user of bundle.usuarios){
        if(Object.keys(user).some(k=>!allowed.includes(k))||!/^\d+$/.test(String(user.id))||ids.has(String(user.id))||logins.has(user.login)||typeof user.ativo!=='boolean'||!/^[a-z0-9._-]{3,60}$/.test(user.login)||!['operador','supervisor','financeiro','administrador'].includes(user.perfil)||typeof user.nome!=='string'||user.nome.length>120||!/^scrypt:[a-f\d]{32}:[a-f\d]{128}$/.test(user.senha_hash))fail('Usuários inválidos no pacote de recuperação');
        ids.add(String(user.id));logins.add(user.login);
    }
    if(!bundle.usuarios.some(u=>u.ativo&&u.perfil==='administrador')||sha256(JSON.stringify(bundle.usuarios))!==bundle.checksum_usuarios)fail('Credenciais incompletas ou sem administrador ativo');
    if(bundle.recuperacoes!==undefined&&(!Array.isArray(bundle.recuperacoes)||bundle.recuperacoes.some(r=>!/^[a-f\d]{64}$/.test(r.token_hash)||!ids.has(String(r.usuario_id))||Object.keys(r).some(k=>!['token_hash','usuario_id','criado_em'].includes(k)))))fail('Histórico de recuperação de acesso inválido');
    return bundle;
}
