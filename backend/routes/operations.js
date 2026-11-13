import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { audit, fail, cents, payments, configValues, tariff, price, civilDate, addMonths, operationKey, ticketId } from '../services/financial-domain.js';
import { isValidPlate, normalizePlate } from '../services/plate-domain.js';
import { lockShift } from '../services/cash-domain.js';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const operational = ['operador', 'supervisor', 'administrador'];
export function createOperationsRouter({ query, tx, allow, timeZone = 'America/Sao_Paulo', clock = () => new Date() }) {
    const router = express.Router();
    const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
    const date = now => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const time = now => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);
    const config = async client => configValues((await client.query('SELECT chave,valor FROM configuracoes')).rows);
    const company = settings => ({ nome: settings.nome_estacionamento || 'Estacionamento', documento: settings.documento_estacionamento || '', endereco: settings.endereco_estacionamento || '', telefone: settings.telefone_estacionamento || '' });
    async function monthly(client, plate, today) {
        const row = (await client.query('SELECT *, TO_CHAR(vencimento,\'YYYY-MM-DD\') AS validade FROM mensalistas WHERE placa=$1 FOR SHARE', [plate])).rows[0];
        return row?.ativo && civilDate(row.validade) >= today ? row : null;
    }
    async function active(client, body, lock = true) {
        const entryId = body.entryId;
        const plate = normalizePlate(body.placa || '');
        if (!entryId && !isValidPlate(plate)) fail('Informe o ticket ou uma placa válida');
        const { rows } = await client.query(`SELECT * FROM historico WHERE status='ativo' AND ${entryId ? 'entry_id=$1' : 'placa=$1'} ORDER BY id ${lock ? 'FOR UPDATE' : ''}`, [entryId || plate]);
        if (rows.length !== 1) fail(rows.length ? 'Há entradas duplicadas para a placa. Solicite conferência ao supervisor.' : 'Entrada ativa não encontrada', rows.length ? 409 : 404);
        if (entryId && plate && rows[0].placa !== plate) fail('O ticket não corresponde à placa', 409);
        return rows[0];
    }
    async function replay(client, key, hash, type, user) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
        const row = (await client.query('SELECT * FROM operacoes_financeiras WHERE chave=$1', [key])).rows[0];
        if (row && (row.requisicao_hash !== hash || row.tipo !== type || String(row.usuario_id) !== String(user.id))) fail('Identificador já utilizado por outra operação', 409);
        return row?.resposta;
    }
    async function saveOperation(client, key, type, ref, user, hash, response) {
        await client.query('INSERT INTO operacoes_financeiras (chave,tipo,referencia,usuario_id,requisicao_hash,resposta,turno_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [key,type,ref,user.id,hash,JSON.stringify(response),response.comprovante.turno_id]);
        await client.query('UPDATE caixa_turnos SET revisao=revisao+1 WHERE id=$1',[response.comprovante.turno_id]);
    }
    router.post('/entrada', allow(...operational), handle(async (req, res) => {
        const plate = normalizePlate(req.body.placa || '');
        if (!isValidPlate(plate)) fail('Placa inválida. Use ABC1234 ou ABC1D23.');
        if (typeof req.body.mensalista !== 'undefined' && typeof req.body.mensalista !== 'boolean') fail('Tipo de cliente inválido');
        if (typeof req.body.diarista !== 'undefined' && typeof req.body.diarista !== 'boolean') fail('Tipo de cliente inválido');
        if (req.body.mensalista && req.body.diarista) fail('Selecione apenas mensalista ou diária');
        const details = ['marca','modelo','cor'].map(field => {
            const value = String(req.body[field] || '').trim();
            if (value.length > (field === 'cor' ? 60 : 120)) fail('Dados do veículo muito longos');
            return value;
        });
        const response = await tx(async client => {
            // Serializa a validação de lotação e a entrada, inclusive entre terminais.
            await client.query('LOCK TABLE historico IN SHARE ROW EXCLUSIVE MODE');
            if ((await client.query("SELECT id FROM historico WHERE placa=$1 AND status='ativo'", [plate])).rows.length) fail('Este veículo já está no pátio', 409);
            const settings = await config(client); const rates = tariff(settings); const now = clock();
            const capacity = Number(settings.total_vagas);
            if (!Number.isInteger(capacity) || capacity < 1) fail('Capacidade não configurada', 503);
            if (Number((await client.query("SELECT COUNT(*)::int AS total FROM historico WHERE status='ativo'")).rows[0].total) >= capacity) fail('Estacionamento lotado', 409);
            const subscriber = req.body.mensalista ? await monthly(client, plate, date(now)) : null;
            if (req.body.mensalista && !subscriber) fail('Mensalista sem contrato ativo e quitado. Regularize o cadastro ou registre como avulso.', 409);
            const id = ticketId();
            const receipt = { tipo: 'entrada', numero: id, placa: plate, marca: details[0], modelo: details[1], cor: details[2], entrada_em: now.toISOString(), categoria: subscriber ? 'Mensalista' : req.body.diarista ? 'Diária (24 h)' : 'Avulso', tarifa: rates, empresa: company(settings), operador: req.user.nome, fuso: timeZone };
            const { rows } = await client.query(`INSERT INTO historico (entry_id,placa,marca,modelo,cor,data_entrada,hora_entrada,status,mensalista,diarista,cliente_nome,cliente_telefone,cliente_cpf,tarifa,criado_em,comprovante_entrada)
                VALUES ($1,$2,$3,$4,$5,$6,$7,'ativo',$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
                [id,plate,...details,date(now),time(now),Boolean(subscriber),Boolean(req.body.diarista),subscriber?.nome || '',subscriber?.telefone || '',subscriber?.cpf || '',JSON.stringify(rates),now.toISOString(),JSON.stringify(receipt)]);
            await audit(client, req.user, 'entrada', { id: rows[0].id, entry_id: id, placa: plate, mensalista: Boolean(subscriber) });
            return { success: true, id: rows[0].id, entry_id: id, criado_em: now.toISOString(), comprovante: receipt };
        });
        res.json(response);
    }));
    router.post('/saida/cotacao', allow(...operational), handle(async (req, res) => {
        const result = await tx(async client => {
            const entry = await active(client, req.body); const now = clock(); const settings = await config(client);
            const subscriber = entry.mensalista ? await monthly(client, entry.placa, date(now)) : null;
            const calculation = price(entry, entry.tarifa || tariff(settings), now, Boolean(subscriber));
            const key = randomBytes(32).toString('hex');
            const quote = { ...calculation, entry_id: entry.entry_id, placa: entry.placa, marca: entry.marca, modelo: entry.modelo, empresa: company(settings), tarifa: entry.tarifa || tariff(settings), operador: req.user.nome, fuso: timeZone };
            await client.query('DELETE FROM cotacoes_saida WHERE expira_em < NOW()');
            await client.query("INSERT INTO cotacoes_saida (chave,historico_id,usuario_id,dados,expira_em) VALUES ($1,$2,$3,$4,NOW()+INTERVAL '2 minutes')", [key,entry.id,req.user.id,JSON.stringify(quote)]);
            return { ...quote, cotacao_id: key, operacao_id: randomBytes(20).toString('hex'), validade_segundos: 120 };
        });
        res.json({ success: true, dados: result });
    }));
    router.post('/saida', allow(...operational), handle(async (req, res) => {
        const key = operationKey(req.body.operacao_id);
        if (!/^[a-f0-9]{64}$/.test(String(req.body.cotacao_id || ''))) fail('Solicite uma cotação antes de confirmar a saída');
        const hash = digest({ cotacao: req.body.cotacao_id, pagamentos: req.body.pagamentos, turno_id:req.body.turno_id });
        const response = await tx(async client => {
            const previous = await replay(client, key, hash, 'saida', req.user); if (previous) return previous;
            const shift=await lockShift(client,req.body.turno_id,req.user);
            const row = (await client.query('SELECT * FROM cotacoes_saida WHERE chave=$1 AND usuario_id=$2 AND expira_em>NOW() FOR UPDATE', [req.body.cotacao_id,req.user.id])).rows[0];
            if (!row) fail('Cotação expirada. Consulte novamente para conferir o valor.', 409);
            const entry = (await client.query("SELECT * FROM historico WHERE id=$1 AND status='ativo' FOR UPDATE", [row.historico_id])).rows[0];
            if (!entry) fail('Esta entrada já foi encerrada', 409);
            const quote = row.dados;
            const normalized = payments(req.body.pagamentos, quote.valor_centavos);
            // Um vencimento ou suspensão posterior à cotação impede usar isenção antiga.
            if (quote.tipo === 'mensalista' && !await monthly(client, entry.placa, date(clock()))) fail('Mensalidade alterada. Consulte novamente o valor.', 409);
            const now = clock(); const method = normalized.length > 1 ? 'Múltiplo' : normalized[0]?.forma_pagamento || null;
            await client.query("UPDATE historico SET status='saído',data_saida=$1,hora_saida=$2,valor_pago=$3,tempo_permanencia=$4,forma_pagamento=$5 WHERE id=$6", [date(now),time(now),quote.valor,quote.tempo,method,entry.id]);
            for (const payment of normalized) await client.query(`INSERT INTO caixa_movimentos (origem,historico_id,placa,valor_pago,forma_pagamento,data_pagamento,hora_pagamento,operacao_chave,turno_id,operador_id,operador_nome)
                VALUES ('saida',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [entry.id,entry.placa,payment.valor_pago,payment.forma_pagamento,date(now),time(now),key,shift.id,req.user.id,req.user.nome]);
            const receipt = { ...quote, turno_id:shift.id, tipo: 'saida', tipo_cliente: ({ mensalista:'Mensalista',diarista:'Diária (24 h)',avulso:'Avulso' })[quote.tipo], numero: key, ticket: entry.entry_id, pagamentos: normalized, saida_em: now.toISOString(), cobranca_ate: quote.saida_em, total: quote.valor };
            const result = { success: true, entry_id: entry.entry_id, placa: entry.placa, valor_pago: quote.valor, comprovante: receipt };
            await audit(client, req.user, 'saida', { entry_id: entry.entry_id, operacao_id: key, total: quote.valor, pagamentos: normalized });
            await saveOperation(client,key,'saida',entry.id,req.user,hash,result);
            await client.query('DELETE FROM cotacoes_saida WHERE chave=$1', [req.body.cotacao_id]);
            return result;
        });
        res.json(response);
    }));
    router.post('/mensalistas/pagamentos', allow('operador','supervisor','financeiro','administrador'), handle(async (req, res) => {
        const key = operationKey(req.body.operacao_id);
        const months = Number(req.body.meses);
        if (!Number.isInteger(months) || months < 1 || months > 24) fail('Informe de 1 a 24 meses');
        const observation = String(req.body.observacao || '').trim();
        if (observation.length > 255) fail('Observação deve ter até 255 caracteres');
        const hash = digest({ id: req.body.mensalista_id, meses: months, pagamentos: req.body.pagamentos, observacao: observation,turno_id:req.body.turno_id });
        const response = await tx(async client => {
            const previous = await replay(client,key,hash,'mensalidade',req.user); if (previous) return previous;
            const shift=await lockShift(client,req.body.turno_id,req.user);
            const entry = (await client.query('SELECT *,TO_CHAR(vencimento,\'YYYY-MM-DD\') AS validade FROM mensalistas WHERE id=$1 FOR UPDATE', [req.body.mensalista_id])).rows[0];
            if (!entry?.ativo) fail('Mensalista não encontrado ou inativo', 409);
            const settings = await config(client); const amount = cents(settings.valor_mensalidade, 'Mensalidade') * months;
            if (amount <= 0) fail('Valor da mensalidade não configurado', 409);
            const normalized = payments(req.body.pagamentos, amount); const now = clock(); const today = date(now);
            const oldDate = civilDate(entry.validade); const next = addMonths(oldDate && oldDate > today ? oldDate : today, months);
            for (const payment of normalized) await client.query(`INSERT INTO caixa_movimentos (origem,mensalista_id,placa,nome,valor_pago,forma_pagamento,data_pagamento,hora_pagamento,observacao,operacao_chave,turno_id,operador_id,operador_nome)
                VALUES ('mensalidade',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [entry.id,entry.placa,entry.nome,payment.valor_pago,payment.forma_pagamento,today,time(now),observation || null,key,shift.id,req.user.id,req.user.nome]);
            await client.query('UPDATE mensalistas SET vencimento=$1,atualizado_em=NOW() WHERE id=$2', [next,entry.id]);
            const receipt = { tipo: 'mensalidade', turno_id:shift.id, numero: key, placa: entry.placa, cliente: entry.nome, meses: months, vencimento_anterior: oldDate, novo_vencimento: next, total: amount / 100, pagamentos: normalized, emitido_em: now.toISOString(), empresa: company(settings), operador: req.user.nome, fuso: timeZone, observacao: observation };
            const result = { success: true, total_pago: amount / 100, novo_vencimento: next, comprovante: receipt };
            await audit(client,req.user,'mensalidade_pagamento',{ mensalista_id: entry.id, operacao_id: key, total: amount / 100, meses: months, novo_vencimento: next });
            await saveOperation(client,key,'mensalidade',entry.id,req.user,hash,result);
            return result;
        });
        res.json(response);
    }));
    router.get('/comprovantes/entrada/:entryId', handle(async (req, res) => {
        const entry = (await query('SELECT comprovante_entrada FROM historico WHERE entry_id=$1', [req.params.entryId])).rows[0];
        if (!entry?.comprovante_entrada) fail('Comprovante original indisponível para este registro antigo', 404);
        res.json({ success: true, dados: entry.comprovante_entrada });
    }));
    router.get('/comprovantes/operacao/:key', handle(async (req, res) => {
        const row = (await query('SELECT resposta FROM operacoes_financeiras WHERE chave=$1', [req.params.key])).rows[0];
        if (!row) fail('Comprovante não encontrado',404);
        res.json({ success: true, dados: row.resposta.comprovante });
    }));
    return router;
}
