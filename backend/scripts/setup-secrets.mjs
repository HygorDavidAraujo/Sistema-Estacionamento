import {randomBytes} from 'node:crypto';
// Executar manualmente no computador do responsável; não grava arquivos ou altera o ambiente.
console.log(JSON.stringify(Object.fromEntries(['BACKUP_ENCRYPTION_KEY','AUTH_RECOVERY_TOKEN'].map(name=>[name,randomBytes(32).toString('hex')])),null,2));
