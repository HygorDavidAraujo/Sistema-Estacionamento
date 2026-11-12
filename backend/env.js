import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const directory = dirname(fileURLToPath(import.meta.url));
// Mesma configuração com npm start em backend/ ou node backend/server.js na raiz.
// Variáveis do ambiente de hospedagem sempre têm precedência.
dotenv.config({ path: resolve(directory, '.env'), quiet: true });
dotenv.config({ path: resolve(directory, '../.env'), quiet: true });
