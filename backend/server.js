import './env.js';
import { randomBytes } from 'node:crypto';
import * as db from './db.js';
import { createApp } from './app.js';
export const config = { maxDuration: 60 };

const production = Boolean(process.env.VERCEL || process.env.NODE_ENV === 'production');
const setupToken = process.env.AUTH_SETUP_TOKEN || process.env.ADMIN_TOKEN || (!production ? randomBytes(24).toString('hex') : '');
const app = createApp({ db, setupToken });
const BASE_PORT = parseInt(process.env.PORT, 10) || 3000;
function startServer(port, retries = 5) {
    const server = app.listen(port, () => {
        console.log(`Servidor rodando na porta ${port}`);
        if (!production && !process.env.AUTH_SETUP_TOKEN && !process.env.ADMIN_TOKEN) {
            console.log(`Primeiro acesso: use o código ${setupToken} para criar o administrador, caso ainda não exista.`);
        }
    });
    server.on('error', err => {
        if (err.code === 'EADDRINUSE' && retries > 0) startServer(port + 1, retries - 1);
        else { console.error('[BACK] Falha ao iniciar servidor:', err.code); process.exit(1); }
    });
}
if (!process.env.VERCEL) startServer(BASE_PORT);
export { app };
export default app;
