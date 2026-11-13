import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createApp } from '../app.js';
import { createDatabaseInitializer } from '../services/database-initialization.js';
export async function testDatabase() {
    const pg = await PGlite.create();
    let ready;
    const normalize = result => ({ ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 });
    const connectionQuery = client => async(sql,params=[]) => normalize(params.length ? await client.query(sql,params) : (await client.exec(sql)).at(-1));
    const initialize = createDatabaseInitializer({
        pool:{ connect:async()=>({query:connectionQuery(pg),release(){}}) },
        loadSql:async()=> (await Promise.all(['migrations/000-compatibility.sql','schema.sql','migrations/001-security.sql','migrations/002-cash-shifts.sql','migrations/003-prepaid-daily.sql','migrations/004-subscriptions-reports.sql'].map(file=>readFile(new URL(`../${file}`,import.meta.url),'utf8')))).join('\n')
    });
    const db = {
        initDb: () => ready ||= initialize().catch(error=>{ready=null;throw error;}),
        query: async (sql,params=[]) => normalize(await pg.query(sql,params)),
        tx: work => pg.transaction(client => work({ query:async (sql,params=[]) => normalize(await client.query(sql,params)) }))
    };
    await db.initDb();
    return { db, pg };
}
export async function testServer(options = {}) {
    const { db,pg } = await testDatabase();
    const app = createApp({ db:{...db,initDb:options.initialize ? ()=>options.initialize(db.initDb) : db.initDb}, env:{ NODE_ENV:'test', AUTH_SETUP_TOKEN:'test-setup-secret' }, ...options });
    const server = await new Promise(resolve => { const s = app.listen(0,'127.0.0.1',() => resolve(s)); });
    const url = `http://127.0.0.1:${server.address().port}`;
    const client = () => {
        let cookie='',csrf='';
        return { get csrf() { return csrf; }, get cookie() { return cookie; }, async request(path,method='GET',body,headers={}) {
            const res = await fetch(`${url}${path}`,{ method,headers:{ ...(cookie?{Cookie:cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers },...(body!==undefined?{body:JSON.stringify(body)}:{}) });
            if (res.headers.get('set-cookie')) cookie=res.headers.get('set-cookie').split(';')[0];
            const data = await res.json().catch(() => ({})); if (data.csrf) csrf=data.csrf;
            return { status:res.status,data,headers:res.headers };
        } };
    };
    return { db,pg,server,url,client,async close(){ server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); await pg.close(); } };
}
