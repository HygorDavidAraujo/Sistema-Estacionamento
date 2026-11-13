import {dailyDeadline,fail} from './financial-domain.js';

export const periodMaxHours=10;
export function workHours(settings){
    const inicio=settings.expediente_inicio??'08:00',fim=settings.expediente_fim??'18:00';
    if(![inicio,fim].every(value=>typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))||inicio===fim)
        fail('Informe horários de início e fim de expediente válidos e diferentes.');
    return {inicio,fim};
}
export async function seedPeriodSettings(client){
    await client.query("INSERT INTO configuracoes (chave,valor,descricao) VALUES ('expediente_inicio','08:00','Início do expediente'),('expediente_fim','18:00','Fim do expediente') ON CONFLICT (chave) DO NOTHING");
}
export function periodWindow(settings,now,timeZone='America/Sao_Paulo'){
    const {inicio,fim}=workHours(settings);
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
    const today=`${parts.year}-${parts.month}-${parts.day}`,current=`${parts.hour}:${parts.minute}`;
    const shiftDate=offset=>{const date=new Date(`${today}T12:00:00Z`);date.setUTCDate(date.getUTCDate()+offset);return date.toISOString().slice(0,10);};
    const overnight=inicio>fim;
    if(!overnight&&(current<inicio||current>=fim)||overnight&&current>=fim&&current<inicio)
        fail('O período só pode ser iniciado durante o expediente configurado.',409);
    const openingDate=overnight&&current<fim?shiftDate(-1):today;
    const closingDate=overnight&&current>=inicio?shiftDate(1):today;
    const opening=dailyDeadline(`${openingDate}T${inicio}`,new Date(0),timeZone);
    const closing=dailyDeadline(`${closingDate}T${fim}`,new Date(0),timeZone);
    const limit=new Date(Math.min(new Date(closing).getTime(),now.getTime()+periodMaxHours*3600000)).toISOString();
    return {retirada_em:limit,inicio_expediente_em:opening,fim_expediente_em:closing,expediente_inicio:inicio,expediente_fim:fim,max_horas:periodMaxHours};
}
