import { randomUUID } from 'node:crypto';

export class OperationError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}
export const fail = (message, status = 400) => { throw new OperationError(message, status); };
export function cents(value, label = 'Valor') {
    if (typeof value !== 'number' && typeof value !== 'string') fail(`${label} inválido`);
    if (typeof value === 'string' && !/^\d+(\.\d{1,2})?$/.test(value)) fail(`${label} inválido`);
    const number = Number(value);
    const rounded = Math.round(number * 100);
    if (!Number.isFinite(number) || number < 0 || rounded > 9999999999 || Math.abs(number * 100 - rounded) > 0.000001) fail(`${label} inválido`);
    return rounded;
}
const methods = new Map([
    ['dinheiro', 'Dinheiro'], ['pix', 'Pix'], ['cartao de credito', 'Cartão de Crédito'],
    ['credito', 'Cartão de Crédito'], ['cartao de debito', 'Cartão de Débito'], ['debito', 'Cartão de Débito']
]);
export function payments(input, expected) {
    if (!Array.isArray(input) || input.length > 12) fail('Informe as formas de pagamento');
    const normalized = input.map(p => {
        const method = methods.get(String(p?.forma_pagamento || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim());
        const amount = cents(p?.valor_pago, 'Pagamento');
        if (!method || amount <= 0) fail('Forma ou valor de pagamento inválido');
        return { forma_pagamento: method, valor_pago: amount / 100 };
    });
    if (normalized.reduce((sum, p) => sum + cents(p.valor_pago), 0) !== expected) fail('A soma dos pagamentos deve corresponder ao valor calculado pelo servidor', 409);
    return normalized;
}
export function civilDate(value) {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    const text = typeof value === 'string' ? value.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const date = new Date(`${text}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : null;
}
export function addMonths(base, months) {
    if (!civilDate(base) || !Number.isInteger(months) || months < 1 || months > 24) fail('Período de mensalidade inválido');
    const [year, month, day] = base.split('-').map(Number);
    const target = new Date(Date.UTC(year, month - 1 + months, 1));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, last));
    return target.toISOString().slice(0, 10);
}
export function configValues(rows) { return Object.fromEntries(rows.map(r => [r.chave, r.valor])); }
export function tariff(config) {
    const tolerance = Number(config.tempo_tolerancia);
    if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 120) fail('Tolerância não configurada corretamente', 503);
    return { inicial: cents(config.valor_hora_inicial), adicional: cents(config.valor_hora_adicional), diaria: cents(config.valor_diaria), tolerancia: tolerance };
}
export function price(entry, settings, now, monthlyEligible = false) {
    const start = new Date(entry.criado_em);
    if (!Number.isFinite(start.getTime())) fail('Horário de entrada inválido', 409);
    const ms = Math.max(0, now.getTime() - start.getTime());
    const minutes = Math.ceil(ms / 60000);
    let amount;
    if (entry.mensalista && monthlyEligible) amount = 0;
    else if (entry.diarista) amount = settings.diaria * Math.max(1, Math.ceil(ms / 86400000));
    else amount = minutes <= settings.tolerancia ? 0 : settings.inicial + Math.ceil(Math.max(0, minutes - 60) / 60) * settings.adicional;
    if (!Number.isSafeInteger(amount) || amount > 9999999999) fail('Valor da permanência excede o limite', 409);
    const seconds = Math.floor(ms / 1000);
    return { valor_centavos: amount, valor: amount / 100, tempo: `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
        entrada_em: start.toISOString(), saida_em: now.toISOString(), tipo: entry.mensalista && monthlyEligible ? 'mensalista' : entry.diarista ? 'diarista' : 'avulso' };
}
export function operationKey(value) {
    if (!value) fail('Identificador da operação é obrigatório');
    if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(value)) fail('Identificador da operação inválido');
    return value;
}
export const ticketId = () => `ent-${randomUUID()}`;
export async function audit(client, user, action, details) {
    await client.query('INSERT INTO auditoria (acao, detalhes, usuario_id, usuario_nome) VALUES ($1,$2,$3,$4)',
        [action, JSON.stringify(details), user?.id || null, user?.nome || 'Sistema']);
}
