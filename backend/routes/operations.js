import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { audit, fail, cents, payments, configValues, tariff, price, monthlyCoverageEnd, civilDate, operationKey, ticketId } from '../services/financial-domain.js';
import { isValidPlate, normalizePlate } from '../services/plate-domain.js';
import { lockShift } from '../services/cash-domain.js';
import {lockSubscription,monthlyQuote,createInvoice} from '../services/subscription-domain.js';
import {periodWindow} from '../services/period-domain.js';
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
        const rows=(await client.query("SELECT m.*,TO_CHAR(m.vencimento,'YYYY-MM-DD') AS validade FROM mensalistas m WHERE m.placa=$1 OR EXISTS (SELECT 1 FROM mensalista_veiculos v WHERE v.mensalista_id=m.id AND v.placa=$1) FOR SHARE OF m",[plate])).rows;
        if(rows.length!==1)return null;const row=rows[0];
        const contract=(await client.query("SELECT c.*,TO_CHAR(c.pago_ate,'YYYY-MM-DD') AS validade,TO_CHAR(c.inicio,'YYYY-MM-DD') AS inicio_iso FROM mensalista_contratos c WHERE mensalista_id=$1 FOR SHARE",[row.id])).rows[0];
        const eligible=row.ativo&&(contract?contract.estado==='ativo'&&contract.inicio_iso<=today&&civilDate(contract.validade)>=today:civilDate(row.validade)>=today);
        return eligible?{...row,validade:contract?.validade||row.validade,limite_simultaneo:contract?.limite_simultaneo||1}:null;
    }
    async function coverage(client,entry){
        if(!entry.mensalista)return null;
        const row=(await client.query("SELECT m.id,m.nome,TO_CHAR(COALESCE(c.pago_ate,m.vencimento),'YYYY-MM-DD') AS validade FROM mensalistas m LEFT JOIN mensalista_contratos c ON c.mensalista_id=m.id WHERE ($1::bigint IS NOT NULL AND m.id=$1) OR ($1::bigint IS NULL AND (m.placa=$2 OR EXISTS (SELECT 1 FROM mensalista_veiculos v WHERE v.mensalista_id=m.id AND v.placa=$2))) FOR SHARE OF m",[entry.mensalista_id||null,entry.placa])).rows[0];
        const current=row?.validade?monthlyCoverageEnd(row.validade,timeZone):null;
        const saved=entry.mensalista_cobertura_ate?new Date(entry.mensalista_cobertura_ate).toISOString():null;
        return {mensalista_id:row?.id||entry.mensalista_id,nome:row?.nome||entry.cliente_nome,pago_ate:row?.validade||null,ate:current&&(!saved||current>saved)?current:saved};
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
    router.post(['/entrada/periodo/cotacao','/entrada/diaria/cotacao'], allow(...operational), handle(async (req, res) => {
        const result = await tx(async client => {
            const now = clock(),settings=await config(client),rates=tariff(settings);
            if (rates.diaria <= 0) fail('Configure um valor de período maior que zero',409);
            return { valor: rates.diaria/100,...periodWindow(settings,now,timeZone),tarifa:rates,fuso:timeZone };
        });
        res.json({success:true,dados:result});
    }));
    router.post('/entrada', allow(...operational), handle(async (req, res) => {
        const plate = normalizePlate(req.body.placa || '');
        if (!isValidPlate(plate)) fail('Placa inválida. Use ABC1234 ou ABC1D23.');
        if (typeof req.body.mensalista !== 'undefined' && typeof req.body.mensalista !== 'boolean') fail('Tipo de cliente inválido');
        if (typeof req.body.diarista !== 'undefined' && typeof req.body.diarista !== 'boolean') fail('Tipo de cliente inválido');
        if (req.body.mensalista && req.body.diarista) fail('Selecione apenas mensalista ou período');
        const details = ['marca','modelo','cor'].map(field => {
            const value = String(req.body[field] || '').trim();
            if (value.length > (field === 'cor' ? 60 : 120)) fail('Dados do veículo muito longos');
            return value;
        });
        const response = await tx(async client => {
            const key = req.body.diarista ? operationKey(req.body.operacao_id) : null;
            const hash = key ? digest({placa:plate,detalhes:details,retirada_em:req.body.retirada_em,turno_id:req.body.turno_id,pagamentos:req.body.pagamentos}) : null;
            if (key) { const previous = await replay(client,key,hash,'diaria',req.user); if (previous) return previous; }
            const shift = key ? await lockShift(client,req.body.turno_id,req.user) : null;
            // Serializa a validação de lotação e a entrada, inclusive entre terminais.
            await client.query('LOCK TABLE historico IN SHARE ROW EXCLUSIVE MODE');
            if ((await client.query("SELECT id FROM historico WHERE placa=$1 AND status='ativo'", [plate])).rows.length) fail('Este veículo já está no pátio', 409);
            const settings = await config(client); const rates = tariff(settings); const now = clock();
            const period=key?periodWindow(settings,now,timeZone):null;
            const deadline = period?.retirada_em||null;
            if (key && rates.diaria <= 0) fail('Configure um valor de período maior que zero',409);
            const normalized = key ? payments(req.body.pagamentos,rates.diaria) : [];
            const capacity = Number(settings.total_vagas);
            if (!Number.isInteger(capacity) || capacity < 1) fail('Capacidade não configurada', 503);
            if (Number((await client.query("SELECT COUNT(*)::int AS total FROM historico WHERE status='ativo'")).rows[0].total) >= capacity) fail('Estacionamento lotado', 409);
            const subscriber = await monthly(client, plate, date(now));
            if (subscriber && req.body.diarista) fail('Placa reconhecida como mensalista com pagamento em dia. Registre a entrada como mensalista, sem cobrar período.',409);
            if (req.body.mensalista && !subscriber) fail('Mensalista sem contrato ativo e quitado. Regularize o cadastro ou registre como avulso.', 409);
            if(subscriber){
                const occupied=(await client.query("SELECT COUNT(*)::int AS n FROM historico h WHERE status='ativo' AND mensalista=true AND (mensalista_id=$1 OR (mensalista_id IS NULL AND (placa=$2 OR EXISTS (SELECT 1 FROM mensalista_veiculos v WHERE v.mensalista_id=$1 AND v.placa=h.placa))))",[subscriber.id,subscriber.placa])).rows[0].n;
                if(occupied>=subscriber.limite_simultaneo)fail('O contrato atingiu o limite de veículos simultâneos no pátio',409);
            }
            const id = ticketId();
            const coverageEnd=subscriber?monthlyCoverageEnd(subscriber.validade,timeZone):null;
            const receipt = { tipo: 'entrada', numero: id, placa: plate, marca: details[0], modelo: details[1], cor: details[2], entrada_em: now.toISOString(), categoria: subscriber ? 'Mensalista' : req.body.diarista ? 'Período pré-pago' : 'Avulso', tarifa: rates, empresa: company(settings), operador: req.user.nome, fuso: timeZone,mensalista_cobertura_ate:coverageEnd,
                ...(key ? { diaria_retirada_em:deadline,diaria_valor_pago:rates.diaria/100,periodo_expediente:period,total:rates.diaria/100,pagamentos:normalized,turno_id:shift.id,operacao_id:key } : {}) };
            const method = normalized.length > 1 ? 'Múltiplo' : normalized[0]?.forma_pagamento || null;
            const { rows } = await client.query(`INSERT INTO historico (entry_id,placa,marca,modelo,cor,data_entrada,hora_entrada,status,mensalista,diarista,cliente_nome,cliente_telefone,cliente_cpf,tarifa,criado_em,comprovante_entrada,diaria_retirada_em,diaria_valor_pago,valor_pago,forma_pagamento,mensalista_id,mensalista_cobertura_ate)
                VALUES ($1,$2,$3,$4,$5,$6,$7,'ativo',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,$18,$19,$20) RETURNING id`,
                [id,plate,...details,date(now),time(now),Boolean(subscriber),Boolean(req.body.diarista),subscriber?.nome || '',subscriber?.telefone || '',subscriber?.cpf || '',JSON.stringify(rates),now.toISOString(),JSON.stringify(receipt),deadline,key ? rates.diaria/100 : null,method,subscriber?.id||null,coverageEnd]);
            for (const payment of normalized) await client.query(`INSERT INTO caixa_movimentos (origem,historico_id,placa,valor_pago,forma_pagamento,data_pagamento,hora_pagamento,operacao_chave,turno_id,operador_id,operador_nome)
                VALUES ('diaria',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[rows[0].id,plate,payment.valor_pago,payment.forma_pagamento,date(now),time(now),key,shift.id,req.user.id,req.user.nome]);
            await audit(client, req.user, 'entrada', { id: rows[0].id, entry_id: id, placa: plate, mensalista: Boolean(subscriber), diaria_retirada_em:deadline, operacao_id:key });
            if(key) await audit(client,req.user,'diaria_pagamento',{entry_id:id,turno_id:shift.id,operacao_id:key,total:rates.diaria/100,pagamentos:normalized,retirada_em:deadline});
            const result = { success: true, id: rows[0].id, entry_id: id, criado_em: now.toISOString(), mensalista:Boolean(subscriber),cliente_nome:subscriber?.nome||'',comprovante: receipt };
            if(key) await saveOperation(client,key,'diaria',rows[0].id,req.user,hash,result);
            return result;
        });
        res.json(response);
    }));
    router.post('/saida/cotacao', allow(...operational), handle(async (req, res) => {
        const result = await tx(async client => {
            const entry = await active(client, req.body); const now = clock(); const settings = await config(client);
            const covered=await coverage(client,entry),eligible=covered?.ate&&now<new Date(covered.ate);
            const expired=entry.mensalista&&!eligible;
            if(expired&&req.body.continuar_avulso!==true)return {mensalista_vencido:true,mensalista_id:covered?.mensalista_id,nome:covered?.nome,placa:entry.placa,entry_id:entry.entry_id,pago_ate:covered?.pago_ate,cobertura_ate:covered?.ate};
            const calculation = price({...entry,mensalista_cobertura_ate:covered?.ate}, entry.tarifa || tariff(settings), now, Boolean(eligible));
            const key = randomBytes(32).toString('hex');
            const quote = { ...calculation,mensalista_vencido:Boolean(expired),confirmacao_avulso:Boolean(expired&&req.body.continuar_avulso===true), entry_id: entry.entry_id, placa: entry.placa, marca: entry.marca, modelo: entry.modelo, empresa: company(settings), tarifa: entry.tarifa || tariff(settings), operador: req.user.nome, fuso: timeZone };
            if(expired)await audit(client,req.user,'mensalista_saida_sem_renovar',{entry_id:entry.entry_id,mensalista_id:covered?.mensalista_id,cobertura_ate:covered?.ate,valor_avulso:calculation.valor});
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
            const quote = row.dados; const now = clock();
            // A cotação não pode estender gratuitamente o período além do limite já pago.
            if (entry.diaria_retirada_em && entry.diaria_valor_pago != null && price(entry,entry.tarifa,now).valor_centavos !== quote.valor_centavos) fail('O valor do atraso mudou. Consulte novamente a saída.',409);
            const normalized = payments(req.body.pagamentos, quote.valor_centavos);
            if(entry.mensalista){const covered=await coverage(client,entry),eligible=Boolean(covered?.ate&&now<new Date(covered.ate));
                const recalculated=price({...entry,mensalista_cobertura_ate:covered?.ate},entry.tarifa||tariff(await config(client)),now,eligible);
                if(recalculated.valor_centavos!==quote.valor_centavos||!eligible&&!quote.confirmacao_avulso||eligible&&quote.confirmacao_avulso)fail('A validade ou o valor mudou. Consulte a saída novamente.',409);
            }
            const method = normalized.length > 1 ? 'Múltiplo' : normalized[0]?.forma_pagamento || null;
            const prepaid = entry.diaria_valor_pago == null ? 0 : cents(entry.diaria_valor_pago)/100;
            const historyMethod = prepaid && method && entry.forma_pagamento !== method ? 'Múltiplo' : method;
            await client.query("UPDATE historico SET status='saído',data_saida=$1,hora_saida=$2,valor_pago=$3,tempo_permanencia=$4,forma_pagamento=COALESCE($5,forma_pagamento) WHERE id=$6", [date(now),time(now),(cents(quote.valor)+cents(prepaid))/100,quote.tempo,historyMethod,entry.id]);
            for (const payment of normalized) await client.query(`INSERT INTO caixa_movimentos (origem,historico_id,placa,valor_pago,forma_pagamento,data_pagamento,hora_pagamento,operacao_chave,turno_id,operador_id,operador_nome)
                VALUES ('saida',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [entry.id,entry.placa,payment.valor_pago,payment.forma_pagamento,date(now),time(now),key,shift.id,req.user.id,req.user.nome]);
            const receipt = { ...quote, turno_id:shift.id, tipo: 'saida', tipo_cliente: quote.mensalista_vencido?'Mensalista · avulso após vencimento':({ mensalista:'Mensalista',diarista:quote.diaria_legada?'Período legado':'Período pré-pago',avulso:'Avulso' })[quote.tipo], numero: key, ticket: entry.entry_id, pagamentos: normalized, saida_em: now.toISOString(), cobranca_ate: quote.saida_em, total: quote.valor };
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
        if (!Number.isInteger(months) || months < 1 || months > 24) fail('Informe de 1 a 24 períodos de 30 dias');
        const observation = String(req.body.observacao || '').trim();
        if (observation.length > 255) fail('Observação deve ter até 255 caracteres');
        const hash = digest({ id: req.body.mensalista_id, meses: months, pagamentos: req.body.pagamentos, observacao: observation,turno_id:req.body.turno_id,revisao:req.body.revisao,cobranca_id:req.body.cobranca_id,valor_recebido:req.body.valor_recebido,periodo_previsto:req.body.periodo_previsto });
        const response = await tx(async client => {
            const previous = await replay(client,key,hash,'mensalidade',req.user); if (previous) return previous;
            const shift=await lockShift(client,req.body.turno_id,req.user);
            const now=clock(),today=date(now);const {customer:entry,contract}=await lockSubscription(client,req.body.mensalista_id,now,timeZone);
            if(!Number.isInteger(req.body.revisao)||req.body.revisao!==contract.revisao)fail('O contrato ou saldo mudou. Consulte a mensalidade novamente.',409);
            const quote=await monthlyQuote(client,entry,contract,months,now,timeZone);
            if(String(req.body.cobranca_id||'')!==String(quote.cobranca_id||''))fail('A cobrança mudou. Consulte novamente.',409);
            if(req.body.periodo_previsto!==quote.fim_periodo)fail('O período mudou. Atualize a previsão de validade.',409);
            const amount=req.body.valor_recebido===undefined?cents(quote.saldo):cents(req.body.valor_recebido,'Valor recebido');
            if(amount<=0||amount>cents(quote.saldo))fail('Recebimento deve ser maior que zero e não superar o saldo',409);
            const normalized=payments(req.body.pagamentos,amount),settings=await config(client);
            const invoiceId=await createInvoice(client,quote,key,req.user);
            const fullyPaid=amount===cents(quote.saldo),oldDate=contract.validade,next=fullyPaid?quote.fim_periodo:oldDate;
            for (const payment of normalized) await client.query(`INSERT INTO caixa_movimentos (origem,mensalista_id,placa,nome,valor_pago,forma_pagamento,data_pagamento,hora_pagamento,observacao,operacao_chave,turno_id,operador_id,operador_nome)
                VALUES ('mensalidade',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [entry.id,entry.placa,entry.nome,payment.valor_pago,payment.forma_pagamento,today,time(now),observation || null,key,shift.id,req.user.id,req.user.nome]);
            await client.query('UPDATE mensalista_cobrancas SET pago=pago+$1,estado=$2,inicio_periodo=$3,fim_periodo=$4,competencia=$5,atualizado_em=NOW() WHERE id=$6',[amount/100,fullyPaid?'paga':'parcial',quote.inicio_periodo,quote.fim_periodo,quote.competencia,invoiceId]);
            await client.query('UPDATE mensalista_contratos SET pago_ate=$1,dia_base=$2,revisao=revisao+1,atualizado_em=NOW() WHERE id=$3',[next,quote.dia_base,contract.id]);
            await client.query('UPDATE mensalistas SET vencimento=$1,atualizado_em=NOW() WHERE id=$2', [next,entry.id]);
            const receipt = { tipo: 'mensalidade', turno_id:shift.id, numero: key, placa: entry.placa, cliente: entry.nome,contrato_id:contract.id,plano:contract.plano,cobranca_id:invoiceId,competencia:quote.competencia,inicio_periodo:quote.inicio_periodo,fim_periodo:quote.fim_periodo,dias:30*months,pagamento_parcial:!fullyPaid,saldo_pendente:(cents(quote.saldo)-amount)/100,total_cobranca:quote.total, meses: months, vencimento_anterior: oldDate, novo_vencimento: next, total: amount / 100, pagamentos: normalized, emitido_em: now.toISOString(), empresa: company(settings), operador: req.user.nome, fuso: timeZone, observacao: observation };
            const result = { success: true, total_pago: amount / 100, novo_vencimento: next, comprovante: receipt };
            await audit(client,req.user,'mensalidade_pagamento',{ mensalista_id: entry.id, operacao_id: key, total: amount / 100, meses: months, novo_vencimento: next });
            await saveOperation(client,key,'mensalidade',entry.id,req.user,hash,result);
            await client.query('UPDATE operacoes_financeiras SET cobranca_id=$1 WHERE chave=$2',[invoiceId,key]);
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
