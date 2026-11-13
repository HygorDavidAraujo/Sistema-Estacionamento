import express from 'express';
import { randomBytes, createHash, scrypt as rawScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { audit, fail, OperationError } from './financial-domain.js';
const scrypt = promisify(rawScrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('hex');
const roles = ['operador', 'supervisor', 'financeiro', 'administrador'];
const publicUser = u => ({ id: u.id, login: u.login, nome: u.nome, perfil: u.perfil, ativo: u.ativo });
function same(a, b) { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && timingSafeEqual(x, y); }
export async function hashPassword(password) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) fail('Use uma senha de 12 a 128 caracteres');
    const salt = randomBytes(16).toString('hex');
    return `scrypt:${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}
export async function verifyPassword(password, hash) {
    if (typeof password !== 'string' || password.length > 128) return false;
    const [algorithm, salt, key] = String(hash || '').split(':');
    if (algorithm !== 'scrypt' || !salt || !key) { await scrypt(password, 'invalid-user-salt', 64); return false; }
    return same((await scrypt(password, salt, 64)).toString('hex'), key);
}
export function createAuth({ query, tx, ready, env, setupToken }) {
    const router = express.Router();
    const production = Boolean(env.VERCEL || env.NODE_ENV === 'production');
    const sessionHours = 8;
    const attempts = new Map();
    function cookie(res, value, clear = false) {
        res.cookie('parking_session', value, { httpOnly: true, secure: production, sameSite: 'strict', path: '/', maxAge: clear ? 0 : sessionHours * 3600000 });
    }
    function wrap(fn) { return async (req, res, next) => { try { if (!await ready()) { res.set('Retry-After','2'); return res.status(503).json({ error: 'Banco de dados temporariamente indisponível. Tente novamente em instantes.', code:'DATABASE_UNAVAILABLE' }); } await fn(req, res, next); } catch (e) { next(e); } }; }
    const requireAuth = async (req, res, next) => {
        const raw = (req.headers.cookie || '').split(';').map(p => p.trim()).find(p => p.startsWith('parking_session='))?.slice(16);
        if (!raw || !/^[a-f0-9]{64}$/.test(raw)) return res.status(401).json({ error: 'Entre com seu usuário e senha' });
        return wrap(async (req, res, next) => {
        const result = await query(`SELECT u.*, s.token_hash, s.csrf_token FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
            WHERE s.token_hash = $1 AND s.expira_em > NOW() AND u.ativo = true`, [digest(raw)]);
        const user = result.rows[0];
        if (!user) return res.status(401).json({ error: 'Sessão encerrada. Entre novamente.' });
        req.user = publicUser(user); req.session = { hash: user.token_hash, csrf: user.csrf_token };
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !same(req.headers['x-csrf-token'], user.csrf_token)) return res.status(403).json({ error: 'Atualize a sessão antes de continuar', code: 'csrf' });
        next();
        })(req,res,next);
    };
    const allow = (...allowed) => (req, res, next) => allowed.includes(req.user?.perfil) ? next() : res.status(403).json({ error: 'Seu perfil não tem permissão para esta operação' });
    const admin = allow('administrador');
    const rateLimit = (req, res, next) => {
        const ip = req.ip || 'unknown'; const now = Date.now();
        for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
        if (attempts.size > 2000) return res.status(429).json({ error: 'Muitas tentativas. Tente mais tarde.' });
        const login = req.path === '/login' ? String(req.body.login || '').trim().toLowerCase().slice(0,60) : 'setup';
        const buckets = [[`ip:${ip}`,60],[`login:${ip}:${login}`,15]].map(([key,limit]) => {
            const item=attempts.get(key)||{count:0,until:now+15*60000};attempts.set(key,item);item.count++;
            return {key,limit,item};
        });
        const blocked=buckets.find(b=>b.item.count>b.limit);
        if (blocked) { res.set('Retry-After', String(Math.ceil((blocked.item.until - now) / 1000))); return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' }); }
        // Logins válidos não consomem a cota de falhas dos funcionários do mesmo terminal/rede.
        res.once('finish',()=>{
            if(res.statusCode>=400)return;
            for(const {key,item} of buckets) if(attempts.get(key)===item && --item.count<=0)attempts.delete(key);
        });
        next();
    };
    async function issueSession(client, user, res) {
        const token = secret(); const csrf = secret();
        await client.query('DELETE FROM sessoes WHERE expira_em <= NOW()');
        await client.query(`INSERT INTO sessoes (token_hash, usuario_id, csrf_token, expira_em) VALUES ($1,$2,$3,NOW() + INTERVAL '8 hours')`, [digest(token), user.id, csrf]);
        return { token, csrf };
    }
    function profile(body) {
        const login = String(body.login || '').trim().toLowerCase();
        const nome = String(body.nome || '').trim();
        if (!/^[a-z0-9._-]{3,60}$/.test(login) || nome.length < 2 || nome.length > 120 || !roles.includes(body.perfil)) fail('Confira nome, usuário e perfil');
        return { login, nome, perfil: body.perfil };
    }
    router.get('/status', wrap(async (_req, res) => {
        const { rows } = await query('SELECT COUNT(*)::int AS total FROM usuarios');
        const recovery=String(env.AUTH_RECOVERY_TOKEN||''),enabled=recovery.length>=32&&recovery.length<=256;
        const used=enabled?(await query('SELECT token_hash FROM auth_recuperacoes WHERE token_hash=$1',[digest(recovery)])).rows.length:1;
        res.json({ success: true, primeiro_acesso: rows[0].total === 0, configuracao_disponivel: Boolean(setupToken),recuperacao_disponivel:rows[0].total>0&&enabled&&!used });
    }));
    router.post('/recovery',rateLimit,wrap(async(req,res)=>{
        const token=String(env.AUTH_RECOVERY_TOKEN||'');
        if(token.length<32||token.length>256||typeof req.body.codigo!=='string'||req.body.codigo.length>256||!same(req.body.codigo,token))fail('Código de recuperação ou administrador inválido',403);
        const hash=await hashPassword(req.body.nova_senha);
        await tx(async client=>{
            await client.query('SELECT pg_advisory_xact_lock($1)',[743221911]);
            if((await client.query('SELECT token_hash FROM auth_recuperacoes WHERE token_hash=$1',[digest(token)])).rows.length)fail('Este código de recuperação já foi utilizado. Configure outro no Vercel.',409);
            const user=(await client.query("SELECT * FROM usuarios WHERE login=$1 AND perfil='administrador' AND ativo=true FOR UPDATE",[String(req.body.login||'').trim().toLowerCase().slice(0,60)])).rows[0];
            if(!user)fail('Código de recuperação ou administrador inválido',403);
            await client.query('UPDATE usuarios SET senha_hash=$1,atualizado_em=NOW() WHERE id=$2',[hash,user.id]);
            await client.query('DELETE FROM sessoes WHERE usuario_id=$1',[user.id]);
            await client.query('INSERT INTO auth_recuperacoes (token_hash,usuario_id) VALUES ($1,$2)',[digest(token),user.id]);
            await audit(client,user,'acesso_administrativo_recuperado',{login:user.login,token_consumido:true});
        });cookie(res,'',true);res.json({success:true,mensagem:'Senha recuperada. Entre com a nova senha. O código de recuperação foi consumido.'});
    }));
    router.post('/setup', rateLimit, wrap(async (req, res) => {
        if (!setupToken || !same(req.body.codigo, setupToken)) fail('Código de primeiro acesso inválido', 403);
        const user = profile({ ...req.body, perfil: 'administrador' });
        const hash = await hashPassword(req.body.senha);
        const result = await tx(async client => {
            await client.query('LOCK TABLE usuarios IN EXCLUSIVE MODE');
            if ((await client.query('SELECT id FROM usuarios LIMIT 1')).rows.length) fail('O primeiro acesso já foi configurado', 409);
            const { rows } = await client.query('INSERT INTO usuarios (login,nome,perfil,senha_hash) VALUES ($1,$2,$3,$4) RETURNING *', [user.login, user.nome, user.perfil, hash]);
            await audit(client, rows[0], 'usuario_primeiro_acesso', { login: user.login });
            return { user: rows[0], session: await issueSession(client, rows[0], res) };
        });
        cookie(res, result.session.token); res.json({ success: true, usuario: publicUser(result.user), csrf: result.session.csrf });
    }));
    router.post('/login', rateLimit, wrap(async (req, res) => {
        const { rows } = await query('SELECT * FROM usuarios WHERE login = $1', [String(req.body.login || '').trim().toLowerCase().slice(0, 60)]);
        const user = rows[0];
        if (!await verifyPassword(req.body.senha, user?.senha_hash) || !user?.ativo) fail('Usuário ou senha inválidos', 401);
        const session = await tx(async client => {
            // Serialize with password/role changes; never issue a session from an outdated credential.
            const current = (await client.query('SELECT * FROM usuarios WHERE id=$1 FOR UPDATE', [user.id])).rows[0];
            if (!current?.ativo || current.senha_hash !== user.senha_hash) fail('Usuário ou senha inválidos', 401);
            await audit(client, user, 'login', {});
            return issueSession(client, user, res);
        });
        cookie(res, session.token); res.json({ success: true, usuario: publicUser(user), csrf: session.csrf });
    }));
    router.get('/me', requireAuth, (req, res) => res.json({ success: true, usuario: req.user, csrf: req.session.csrf }));
    router.post('/logout', requireAuth, wrap(async (req, res) => {
        await query('DELETE FROM sessoes WHERE token_hash=$1', [req.session.hash]);
        cookie(res, '', true); res.json({ success: true });
    }));
    router.post('/senha', requireAuth, wrap(async (req, res) => {
        const hash = await hashPassword(req.body.nova_senha);
        await tx(async client => {
            const user = (await client.query('SELECT * FROM usuarios WHERE id=$1 FOR UPDATE', [req.user.id])).rows[0];
            if (!await verifyPassword(req.body.senha_atual, user?.senha_hash)) fail('Senha atual inválida', 403);
            await client.query('UPDATE usuarios SET senha_hash=$1, atualizado_em=NOW() WHERE id=$2', [hash, req.user.id]);
            await client.query('DELETE FROM sessoes WHERE usuario_id=$1', [req.user.id]);
            await audit(client, req.user, 'senha_alterada', {});
        });
        cookie(res, '', true); res.json({ success: true });
    }));
    router.get('/users', requireAuth, admin, wrap(async (_req, res) => {
        res.json({ success: true, dados: (await query('SELECT id,login,nome,perfil,ativo FROM usuarios ORDER BY nome')).rows });
    }));
    router.post('/users', requireAuth, admin, wrap(async (req, res) => {
        const user = profile(req.body); const hash = await hashPassword(req.body.senha);
        const active = req.body.ativo ?? true;
        if (typeof active !== 'boolean') fail('Status inválido');
        const result = await tx(async client => {
            const { rows } = await client.query('INSERT INTO usuarios (login,nome,perfil,senha_hash,ativo) VALUES ($1,$2,$3,$4,$5) RETURNING *', [user.login, user.nome, user.perfil, hash, active]);
            await audit(client, req.user, 'usuario_criado', { id: rows[0].id, ...user });
            return rows[0];
        });
        res.status(201).json({ success: true, dados: publicUser(result) });
    }));
    router.patch('/users/:id', requireAuth, admin, wrap(async (req, res) => {
        const hash = req.body.senha ? await hashPassword(req.body.senha) : null;
        const result = await tx(async client => {
            await client.query('LOCK TABLE usuarios IN EXCLUSIVE MODE');
            const old = (await client.query('SELECT * FROM usuarios WHERE id=$1', [req.params.id])).rows[0];
            if (!old) fail('Usuário não encontrado', 404);
            const user = profile({ ...old, ...req.body, login: old.login });
            const active = req.body.ativo ?? old.ativo;
            if (typeof active !== 'boolean') fail('Status inválido');
            if(!active&&(await client.query("SELECT id FROM caixa_turnos WHERE operador_id=$1 AND estado='aberto'",[old.id])).rows.length)fail('Encerre o turno de caixa deste usuário antes de desativá-lo',409);
            if (old.perfil === 'administrador' && old.ativo && (user.perfil !== 'administrador' || !active)) {
                if ((await client.query("SELECT id FROM usuarios WHERE perfil='administrador' AND ativo=true AND id<>$1", [old.id])).rows.length === 0) fail('Mantenha pelo menos um administrador ativo', 409);
            }
            const { rows } = await client.query('UPDATE usuarios SET nome=$1,perfil=$2,ativo=$3,senha_hash=COALESCE($4,senha_hash), atualizado_em=NOW() WHERE id=$5 RETURNING *', [user.nome, user.perfil, active, hash, old.id]);
            await client.query('DELETE FROM sessoes WHERE usuario_id=$1', [old.id]);
            await audit(client, req.user, 'usuario_alterado', { id: old.id, perfil: user.perfil, ativo: active });
            return rows[0];
        });
        res.json({ success: true, dados: publicUser(result) });
    }));
    return { router, requireAuth, allow };
}
