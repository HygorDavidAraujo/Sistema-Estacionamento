import { fail, civilDate } from './financial-domain.js';
export const civilToday=(now,timeZone)=>new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
export function paging(input,max=200){
    const parse=(value,fallback)=>value===undefined?fallback:Number(value);
    const page=parse(input.pagina,1),size=parse(input.limite??input.limit,50);
    if(!Number.isInteger(page)||page<1||page>1000000||!Number.isInteger(size)||size<1||size>max)fail('Paginação inválida');
    return {page,size,offset:(page-1)*size};
}
export const pageInfo=(p,total)=>({pagina:p.page,limite:p.size,total:Number(total),paginas:Math.max(1,Math.ceil(Number(total)/p.size))});
export function filters(input,column){
    const params=[],parts=[];
    const add=(sql,value)=>{params.push(value);parts.push(sql.replace('?',`$${params.length}`));};
    for(const [key,op]of [['dataInicio','>='],['dataFim','<=']])if(input[key]){
        let date=String(input[key]);if(/^\d{2}\/\d{2}\/\d{4}$/.test(date))date=date.split('/').reverse().join('-');
        if(civilDate(date)!==date)fail('Data inválida');add(`${column} ${op} ?::date`,date);
    }
    if(params.length===2&&params[0]>params[1])fail('A data inicial deve anteceder a final');
    for(const [key,unit,min,max]of [['dia','DAY',1,31],['mes','MONTH',1,12],['ano','YEAR',1900,9999]])if(input[key]){
        const n=Number(input[key]);if(!Number.isInteger(n)||n<min||n>max)fail('Filtro de data inválido');add(`EXTRACT(${unit} FROM ${column}) = ?`,n);
    }
    return {params,parts,add,where:()=>parts.length?` WHERE ${parts.join(' AND ')}`:''};
}
export function csvCell(value){const raw=String(value??'');return `"${(/^[\s]*[=+@-]/.test(raw)?"'":'')+raw.replace(/"/g,'""')}"`;}
export const csvText=rows=>'\uFEFF'+rows.map(row=>row.map(csvCell).join(';')).join('\r\n');
