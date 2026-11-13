import {fail,cents,civilDate} from './financial-domain.js';
import {civilToday} from './query-domain.js';
import {normalizePlate,isValidPlate} from './plate-domain.js';
export const contractColumns="c.*,TO_CHAR(c.inicio,'YYYY-MM-DD') AS inicio_iso,TO_CHAR(c.pago_ate,'YYYY-MM-DD') AS validade";
export const invoiceColumns="b.*,TO_CHAR(b.competencia,'YYYY-MM-DD') AS competencia_iso,TO_CHAR(b.inicio_periodo,'YYYY-MM-DD') AS inicio_iso,TO_CHAR(b.fim_periodo,'YYYY-MM-DD') AS fim_iso,TO_CHAR(b.vencimento,'YYYY-MM-DD') AS vencimento_iso";
export async function seedLegacySubscriptions(client){
    await client.query(`INSERT INTO mensalista_contratos (mensalista_id,valor_mensal,inicio,dia_base,pago_ate,estado)
        SELECT m.id,GREATEST(COALESCE((SELECT valor::numeric FROM configuracoes WHERE chave='valor_mensalidade'),300),0.01),
        (m.criado_em AT TIME ZONE 'America/Sao_Paulo')::date,EXTRACT(DAY FROM COALESCE(m.vencimento,(m.criado_em AT TIME ZONE 'America/Sao_Paulo')::date))::int,
        m.vencimento,CASE WHEN m.ativo THEN 'ativo' ELSE 'suspenso' END FROM mensalistas m ON CONFLICT (mensalista_id) DO NOTHING`);
    await client.query('INSERT INTO mensalista_veiculos (mensalista_id,placa) SELECT id,placa FROM mensalistas ON CONFLICT (placa) DO NOTHING');
}
export function addPaidPeriods(base,months){
    const target=new Date(`${base}T00:00:00Z`);target.setUTCDate(target.getUTCDate()+30*months);
    return target.toISOString().slice(0,10);
}
export function subscriptionState(customer,contract,today){
    if(!contract)return customer.ativo===false?'suspenso':!customer.validade?'sem_pagamento':customer.validade<today?'vencido':'em_dia';
    if(contract.estado!=='ativo')return contract.estado;
    if(!customer.ativo)return 'suspenso';
    if(!contract.validade)return 'sem_pagamento';
    if(contract.inicio_iso>today)return 'a_iniciar';
    if(contract.validade<today)return 'vencido';
    if(contract.validade===today)return 'vence_hoje';
    return Date.parse(`${contract.validade}T00:00Z`)-Date.parse(`${today}T00:00Z`)<=2*86400000?'a_vencer':'em_dia';
}
export async function lockSubscription(client,id,now,timeZone){
    if(!/^\d+$/.test(String(id||'')))fail('Mensalista inválido');
    const customer=(await client.query("SELECT m.*,TO_CHAR(m.vencimento,'YYYY-MM-DD') AS validade FROM mensalistas m WHERE id=$1 FOR UPDATE",[id])).rows[0];
    if(!customer)fail('Mensalista não encontrado',404);
    let contract=(await client.query(`SELECT ${contractColumns} FROM mensalista_contratos c WHERE mensalista_id=$1 FOR UPDATE`,[id])).rows[0];
    if(!contract){
        const amount=(await client.query("SELECT valor FROM configuracoes WHERE chave='valor_mensalidade'")).rows[0]?.valor;
        if(cents(amount)<=0)fail('Valor da mensalidade não configurado',409);
        const base=civilToday(now,timeZone);
        await client.query("INSERT INTO mensalista_contratos (mensalista_id,valor_mensal,inicio,dia_base,pago_ate,estado) VALUES ($1,$2,$3,$4,$5,$6)",[id,amount,base,Number((customer.validade||base).slice(8)),customer.validade,customer.ativo?'ativo':'suspenso']);
        await client.query('INSERT INTO mensalista_veiculos (mensalista_id,placa) VALUES ($1,$2) ON CONFLICT (placa) DO NOTHING',[id,customer.placa]);
        contract=(await client.query(`SELECT ${contractColumns} FROM mensalista_contratos c WHERE mensalista_id=$1 FOR UPDATE`,[id])).rows[0];
    }
    return {customer,contract};
}
export async function monthlyQuote(client,customer,contract,months,now,timeZone){
    if(contract.estado==='cancelado')fail('Contrato cancelado. Reative com justificativa antes de cobrar.',409);
    const open=(await client.query(`SELECT ${invoiceColumns} FROM mensalista_cobrancas b WHERE contrato_id=$1 AND estado IN ('aberta','parcial') FOR UPDATE`,[contract.id])).rows[0];
    months=months??(open?Number(open.meses):1);
    if(!Number.isInteger(months)||months<1||months>24)fail('Informe de 1 a 24 períodos de 30 dias');
    if(open&&Number(open.meses)!==months)fail(`Existe cobrança aberta de ${open.meses} período(s) de 30 dias. Quite ou cancele essa cobrança antes de mudar o período.`,409);
    const today=civilToday(now,timeZone),paid=contract.validade;
    const base=paid&&paid>=today?paid:today;
    const anchor=Number(base.slice(8));
    const total=open?cents(open.total):cents(contract.valor_mensal)*months;
    if(total>9999999999)fail('Valor da cobrança excede o limite');
    return {mensalista_id:customer.id,contrato_id:contract.id,cliente:customer.nome,placa:customer.placa,plano:contract.plano,estado:contract.estado,revisao:contract.revisao,
        cobranca_id:open?.id||null,meses:months,valor_mensal:Number(open?.valor_mensal??contract.valor_mensal),total:total/100,pago:open?Number(open.pago):0,saldo:(total-(open?cents(open.pago):0))/100,
        competencia:`${base.slice(0,7)}-01`,inicio_periodo:base,fim_periodo:addPaidPeriods(base,months),
        vencimento:open?.vencimento_iso||base,dia_base:open?.dia_base||anchor,pago_ate:paid,renovacao:contract.renovacao};
}
export async function createInvoice(client,quote,key,user){
    if(quote.cobranca_id)return quote.cobranca_id;
    return (await client.query(`INSERT INTO mensalista_cobrancas (contrato_id,chave,criada_por,competencia,inicio_periodo,fim_periodo,vencimento,meses,dia_base,valor_mensal,total)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,[quote.contrato_id,key,user.id,quote.competencia,quote.inicio_periodo,quote.fim_periodo,quote.vencimento,quote.meses,quote.dia_base,quote.valor_mensal,quote.total])).rows[0].id;
}
export function customerInput(body){
    const text=(key,max)=>{if(body[key]!=null&&typeof body[key]!=='string')fail(`Campo ${key} inválido`);const v=String(body[key]||'').trim();if(v.length>max)fail(`Campo ${key} muito longo`);return v;};
    const nome=text('nome',120);if(!nome)fail('Informe o nome do cliente');
    const cpfText=text('cpf',20),phoneText=text('telefone',40),cpf=cpfText.replace(/\D/g,''),telefone=phoneText.replace(/\D/g,'');
    if(cpfText&&!cpf||phoneText&&!telefone)fail('CPF ou telefone inválido');
    if(cpf){if(cpf.length!==11||/^(\d)\1+$/.test(cpf))fail('CPF inválido');for(let n=9;n<11;n++){let sum=0;for(let i=0;i<n;i++)sum+=Number(cpf[i])*(n+1-i);const digit=(sum*10)%11;if(Number(cpf[n])!==(digit===10?0:digit))fail('CPF inválido');}}
    if(telefone&&!/^\d{10,13}$/.test(telefone))fail('Telefone inválido. Informe DDD e número.');
    const placa=normalizePlate(text('placa',16));if(!isValidPlate(placa))fail('Placa inválida');
    if(body.veiculos!==undefined&&(!Array.isArray(body.veiculos)||body.veiculos.length>20))fail('Informe até 20 veículos');
    const veiculos=[...new Set([placa,...(body.veiculos||[]).map(p=>normalizePlate(String(p)))])];
    if(veiculos.length>20||veiculos.some(p=>!isValidPlate(p)))fail('Confira as placas autorizadas');
    return {nome,cpf:cpf||null,telefone:telefone||null,placa,veiculos};
}
export function contractInput(body,today){
    const plano=String(body.plano||'Mensal').trim();if(!plano||plano.length>80)fail('Nome do plano inválido');
    const valor=cents(body.valor_mensal,'Valor mensal');if(valor<=0)fail('O valor mensal deve ser maior que zero');
    const inicio=body.inicio||today;if(civilDate(inicio)!==inicio||inicio>today)fail('Início do contrato inválido ou futuro');
    const limite=Number(body.limite_simultaneo??1);if(!Number.isInteger(limite)||limite<1||limite>20)fail('Limite simultâneo deve ser de 1 a 20 veículos');
    const estado=body.estado||'ativo',renovacao='pagamento';if(!['ativo','suspenso','cancelado'].includes(estado))fail('Situação inválida');
    return {plano,valor_mensal:valor/100,inicio,limite_simultaneo:limite,estado,renovacao};
}
