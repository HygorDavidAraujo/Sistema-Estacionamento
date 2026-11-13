// Aplicação real com PostgreSQL em memória; sem .env ou banco operacional.
import { createApp } from '../app.js';
import { hashPassword } from '../services/auth.js';
import { testDatabase } from './test-database.js';
const { db,pg } = await testDatabase();
await db.query('INSERT INTO usuarios (login,nome,perfil,senha_hash) VALUES ($1,$2,$3,$4)', ['teste','Operador de teste','administrador',await hashPassword('Senha-teste-123')]);
const app=createApp({db,env:{NODE_ENV:'test'},plateFetch:async url=>Response.json({brand:'MARCA TESTE',model:url.includes('DEF4G56')?'VEÍCULO B':'VEÍCULO A',color:'Cinza'})});
// Preparação exclusiva deste servidor isolado, sem equivalente na aplicação real.
app.post('/__test/prepare',async (req,res)=>{
    const { placa,minutes=65,mensalista=false }=req.body;
    if(!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(placa)) return res.sendStatus(400);
    if(mensalista) await db.query("INSERT INTO mensalistas (placa,nome,vencimento) VALUES ($1,'Cliente de teste','2099-01-31') ON CONFLICT (placa) DO UPDATE SET ativo=true,vencimento='2099-01-31'",[placa]);
    else await db.query("UPDATE historico SET criado_em=NOW()-($1::int * INTERVAL '1 minute') WHERE placa=$2 AND status='ativo'",[minutes,placa]);
    res.json({success:true});
});
app.post('/__shutdown',(_req,res)=>{
    res.end('ok'); setImmediate(async()=>{server.closeAllConnections();server.close();await pg.close();});
});
const server=app.listen(3108,'127.0.0.1',()=>console.log('Preview de teste: http://127.0.0.1:3108'));
