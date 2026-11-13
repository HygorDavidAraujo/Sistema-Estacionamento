import { fail, cents, civilDate } from './financial-domain.js';
export const cashManagers = ['supervisor','administrador'];
export const isCashManager = user => cashManagers.includes(user?.perfil);
export const ownShift = (shift,user) => String(shift.operador_id) === String(user.id);
export function reason(value, required = true) {
    const result=String(value || '').trim();
    if(result.length>255 || required && result.length<10) fail('Informe uma justificativa de 10 a 255 caracteres');
    return result;
}
export async function lockShift(client,id,user,{own=true,open=true}={}) {
    if(!/^\d+$/.test(String(id||'')))fail('Abra ou selecione o turno de caixa antes de continuar',409);
    const shift=(await client.query('SELECT *,TO_CHAR(data_ref,\'YYYY-MM-DD\') AS data_iso FROM caixa_turnos WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!shift || shift.estado==='legado')fail('Turno não encontrado ou sem controle financeiro',409);
    if(open && shift.estado!=='aberto')fail('O turno está encerrado. Abra um novo turno.',409);
    if(!ownShift(shift,user) && (own || !isCashManager(user)))fail('O caixa pertence a outro operador. Faça a troca de turno.',403);
    return shift;
}
export function visibleShift(shift,user){
    if(!ownShift(shift,user) && !isCashManager(user) && user.perfil!=='financeiro')fail('Seu perfil não permite consultar este turno',403);
}
export async function shiftSummary(client,shift) {
    const amounts=(await client.query(`SELECT
        COALESCE(SUM(valor_pago),0) AS recebido,
        COALESCE(SUM(valor_pago) FILTER (WHERE forma_pagamento='Dinheiro'),0) AS dinheiro,
        COALESCE(SUM(valor_pago) FILTER (WHERE forma_pagamento='Cartão de Crédito'),0) AS credito,
        COALESCE(SUM(valor_pago) FILTER (WHERE forma_pagamento='Cartão de Débito'),0) AS debito,
        COALESCE(SUM(valor_pago) FILTER (WHERE forma_pagamento='Pix'),0) AS pix,
        COUNT(DISTINCT operacao_chave)::int AS recebimentos,COUNT(*)::int AS parcelas
        FROM caixa_movimentos WHERE turno_id=$1`,[shift.id])).rows[0];
    const adjustments=(await client.query(`SELECT
        COALESCE(SUM(valor) FILTER (WHERE tipo='suprimento'),0) AS suprimentos,
        COALESCE(SUM(valor) FILTER (WHERE tipo='sangria'),0) AS sangrias
        FROM caixa_ajustes WHERE turno_id=$1`,[shift.id])).rows[0];
    const counts=(await client.query(`SELECT COUNT(*) FILTER (WHERE tipo='saida')::int AS saidas,
        COUNT(*) FILTER (WHERE tipo='mensalidade')::int AS mensalidades,
        COUNT(*) FILTER (WHERE tipo='diaria')::int AS diarias FROM operacoes_financeiras WHERE turno_id=$1`,[shift.id])).rows[0];
    const fund=cents(shift.fundo_inicial),cash=cents(amounts.dinheiro),supply=cents(adjustments.suprimentos),withdraw=cents(adjustments.sangrias);
    return {turno_id:shift.id,revisao:shift.revisao,fundo_inicial:fund/100,total_recebido:cents(amounts.recebido)/100,
        total_dinheiro:cash/100,total_credito:cents(amounts.credito)/100,total_debito:cents(amounts.debito)/100,total_pix:cents(amounts.pix)/100,
        suprimentos:supply/100,sangrias:withdraw/100,saldo_esperado:(fund+cash+supply-withdraw)/100,
        total_transacoes:amounts.recebimentos,total_parcelas:amounts.parcelas,saidas:counts.saidas,mensalidades:counts.mensalidades,diarias:counts.diarias};
}
export function dateRange(input) {
    const result={};for(const key of ['dataInicio','dataFim'])if(input[key]){result[key]=civilDate(String(input[key]));if(!result[key] || result[key]!==input[key])fail('Período inválido');}
    if(result.dataInicio && result.dataFim && result.dataInicio>result.dataFim)fail('A data inicial deve anteceder a final');
    return result;
}
