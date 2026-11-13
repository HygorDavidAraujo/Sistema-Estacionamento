(function () {
    const receipts = new Map();
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
    const money = value => Number(value || 0).toLocaleString('pt-BR',{ style:'currency',currency:'BRL' });
    const titles = { entrada:'Comprovante de entrada',saida:'Comprovante de saída',mensalidade:'Pagamento de mensalidade',abertura_caixa:'Abertura de caixa',movimento_caixa:'Movimento de caixa',fechamento_caixa:'Conferência de fechamento' };
    const style = `
        .receipt,.receipt *{box-sizing:border-box}.receipt{color:#000;font:11px/1.18 Arial,sans-serif}
        .receipt{width:100%;padding:1.5mm 2mm;overflow-wrap:anywhere}.receipt h1{font-size:13px;margin:0 0 1mm;text-align:center}
        .receipt h2{font-size:12px;text-align:center;margin:1mm 0;padding:1mm 0;border-top:1px dashed #555;border-bottom:1px dashed #555}
        .receipt p{margin:.6mm 0}.receipt .center{text-align:center}.receipt .line{display:flex;justify-content:space-between;gap:2mm;margin:.6mm 0}
        .receipt .line span:last-child{text-align:right}.receipt .total{font-size:14px;font-weight:bold;border-top:1px dashed #555;margin-top:1mm;padding-top:1mm}
        .receipt .line span:first-child{flex-shrink:0;max-width:55%;overflow-wrap:normal}.receipt .line span:last-child{min-width:0}
        .receipt .small{font-size:9px}.receipt .qr{display:flex;justify-content:center;margin:1.5mm auto}.receipt .qr img,.receipt .qr canvas{display:block;max-width:25mm!important;height:auto!important}
        .receipt .footer{border-top:1px dashed #555;margin-top:1mm;padding-top:1mm}.receipt .plate{font-size:16px;font-weight:bold;text-align:center;letter-spacing:1px}
        @media print{body{width:100%;-webkit-print-color-adjust:exact;print-color-adjust:exact}.receipt{padding:1mm 1.5mm}h1,h2,.line,.qr{break-inside:avoid}}`;
    function formatDate(value, tz) { return value ? new Date(value).toLocaleString('pt-BR',{ timeZone:tz || 'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit' }) : '-'; }
    const line = (label,value,cls='') => `<div class="line ${cls}"><span>${escape(label)}</span><span>${escape(value)}</span></div>`;
    function cashHtml(receipt){
        const company=receipt.empresa||{};let result=`<article class="receipt"><h1>${escape(company.nome||'Estacionamento')}</h1>`;
        for(const detail of [company.documento,company.endereco,company.telefone])if(detail)result+=`<p class="center small">${escape(detail)}</p>`;
        result+=`<h2>${titles[receipt.tipo]}</h2>`+line('Caixa principal · turno',receipt.turno_id);
        if(receipt.responsavel)result+=line('Responsável',receipt.responsavel);
        if(receipt.aberto_em)result+=line('Abertura',formatDate(receipt.aberto_em,receipt.fuso));
        result+=line('Registro',formatDate(receipt.emitido_em,receipt.fuso));
        if(receipt.tipo==='abertura_caixa')result+=line('Fundo inicial',money(receipt.fundo_inicial),'total');
        if(receipt.tipo==='movimento_caixa')result+=line(receipt.movimento==='sangria'?'SANGRIA':'SUPRIMENTO',money(receipt.total),'total');
        if(receipt.tipo==='fechamento_caixa'){
            const s=receipt.resumo;result+=line('Versão',receipt.versao)+line('Fundo inicial',money(s.fundo_inicial))+line('Recebimentos',money(s.total_recebido))+line('Suprimentos / sangrias',`${money(s.suprimentos)} / ${money(s.sangrias)}`);
            result+='<h2>Esperado / conferido / diferença</h2>';
            for(const [key,label,expected] of [['dinheiro','Dinheiro',s.saldo_esperado],['pix','Pix',s.total_pix],['credito','Crédito',s.total_credito],['debito','Débito',s.total_debito]]){
                result+=line(label,`${money(expected)} / ${money(receipt.contagem[key])}`)+line('Diferença',money(receipt.diferencas[key]),'small');
            }
            result+=line('Recebimentos / parcelas',`${s.total_transacoes} / ${s.total_parcelas}`)+line('Veículos permanecem no pátio',receipt.veiculos_no_patio)+`<p class="small">Situação no registro: ${escape(receipt.situacao)}</p>`;
        }
        if(receipt.observacao)result+=`<p class="small">Motivo/observação: ${escape(receipt.observacao)}</p>`;
        return result+`<div class="footer small"><p>Operador: ${escape(receipt.operador)}</p><p>Operação: ${escape(receipt.numero)}</p></div></article>`;
    }
    function html(receipt, qrId) {
        if(['abertura_caixa','movimento_caixa','fechamento_caixa'].includes(receipt.tipo))return cashHtml(receipt);
        const company = receipt.empresa || {}; const tz = receipt.fuso;
        let result = `<article class="receipt"><h1>${escape(company.nome || 'Estacionamento')}</h1>`;
        for (const detail of [company.documento,company.endereco,company.telefone]) if (detail) result += `<p class="center small">${escape(detail)}</p>`;
        result += `<h2>${titles[receipt.tipo] || 'Comprovante'}</h2><p class="plate">${escape(receipt.placa)}</p>`;
        const vehicle = [receipt.marca,receipt.modelo,receipt.cor].filter(Boolean).join(' · ');
        if (vehicle) result += `<p class="center">${escape(vehicle)}</p>`;
        if (receipt.tipo === 'entrada') {
            result += line('Entrada',formatDate(receipt.entrada_em,tz)) + line('Tipo',String(receipt.categoria||'').replace('Diária antecipada','Período pré-pago').replace('Diária','Período'));
            const rates = receipt.tarifa;
            if (rates && receipt.categoria !== 'Mensalista') {
                result += line(receipt.diaria_retirada_em?'Atraso: 1ª hora / adicional':'1ª hora / adicional',`${money(rates.inicial/100)} / ${money(rates.adicional/100)}`);
                if(!receipt.diaria_retirada_em){result += line('Tolerância inicial',`${rates.tolerancia} min`);result += line('Período pré-pago',money(rates.diaria/100));}
            }
            if(receipt.diaria_retirada_em)result+=`<div class="total center"><p class="small">LIMITE DO PERÍODO</p><p data-period-limit>${escape(formatDate(receipt.diaria_retirada_em,tz))}</p></div><p class="small">Saída livre até o limite. Preço fixo, sem desconto. Após o limite: tarifa avulsa por hora iniciada, sem nova tolerância.</p>`;
            if(receipt.mensalista_cobertura_ate)result+=line('Benefício mensalista até',formatDate(new Date(new Date(receipt.mensalista_cobertura_ate).getTime()-1).toISOString(),tz));
            result += `<div class="qr" id="${qrId}"></div><p class="center small">Apresente este ticket na saída.</p>`;
        } else if (receipt.tipo === 'saida') {
            result += line('Entrada',formatDate(receipt.entrada_em,tz)) + line('Saída',formatDate(receipt.saida_em,tz)) + line('Permanência',receipt.tempo);
            result += line('Tipo',String(receipt.tipo_cliente || ({ mensalista:'Mensalista',diarista:'Período pré-pago',avulso:'Avulso' }[receipt.categoria]) || 'Avulso').replace('Diária antecipada','Período pré-pago').replace('Diária','Período'));
            if(receipt.diaria_retirada_em)result+=line('Limite do período',formatDate(receipt.diaria_retirada_em,tz))+line('Pago na entrada',money(receipt.diaria_valor_pago))+line('Atraso',`${receipt.atraso_minutos} min`);
            if(receipt.mensalista_vencido)result+=line('Avulso após',formatDate(receipt.mensalista_cobertura_ate,tz))+'<p class="small">Cliente optou por não renovar. Período já quitado preservado.</p>';
            if (receipt.cobranca_ate) result += line('Cálculo até',formatDate(receipt.cobranca_ate,tz));
        } else {
            result += line('Cliente',receipt.cliente) + line('Pagamento',formatDate(receipt.emitido_em,tz)) + line('Período',receipt.dias?`${receipt.dias} dias`:`${receipt.meses} ${receipt.meses === 1 ? 'mês':'meses'}`);
            if(receipt.cobranca_id)result+=line('Contrato / cobrança',`#${receipt.contrato_id} / #${receipt.cobranca_id}`)+line('Competência',receipt.competencia.slice(0,7));
            if (receipt.vencimento_anterior) result += line('Vencimento anterior',receipt.vencimento_anterior.split('-').reverse().join('/'));
            if(receipt.novo_vencimento)result += line('Pago até',receipt.novo_vencimento.split('-').reverse().join('/'));
            if(receipt.pagamento_parcial)result+='<p class="small">PAGAMENTO PARCIAL: novo período ainda não liberado.</p>'+line('Saldo da cobrança',money(receipt.saldo_pendente));
        }
        if (receipt.tipo !== 'entrada' || receipt.diaria_retirada_em) {
            result += line(receipt.diaria_retirada_em?(receipt.tipo==='entrada'?'PERÍODO PAGO':'PAGO NA SAÍDA'):'TOTAL PAGO',money(receipt.total),'total');
            for (const payment of receipt.pagamentos || []) result += line(payment.forma_pagamento,money(payment.valor_pago));
            if (!(receipt.pagamentos || []).length) result += `<p class="small">${receipt.diaria_retirada_em?'Sem cobrança adicional.':'Sem cobrança, conforme regra da permanência.'}</p>`;
            if(receipt.tipo==='saida'&&receipt.diaria_retirada_em)result+=line('Total da permanência',money((Math.round(receipt.diaria_valor_pago*100)+Math.round(receipt.total*100))/100));
        }
        if (receipt.observacao) result += `<p class="small">Obs.: ${escape(receipt.observacao)}</p>`;
        result += `<div class="footer small"><p>Operador: ${escape(receipt.operador || '-')}</p><p>${receipt.tipo === 'entrada' ? 'Ticket':'Operação'}: ${escape(receipt.numero)}</p>`;
        if (receipt.ticket) result += `<p>Ticket: ${escape(receipt.ticket)}</p>`;
        if (receipt.operacao_id) result += `<p>Pagamento: ${escape(receipt.operacao_id)}</p>`;
        if (receipt.turno_id) result += `<p>Turno de caixa: ${escape(receipt.turno_id)}</p>`;
        return `${result}</div></article>`;
    }
    async function render(target, receipt) {
        receipts.set(target, structuredClone(receipt));
        document.getElementById(target).innerHTML = `<style>${style}</style>${html(receipt,`${target}-qr`)}`;
        if (receipt.tipo === 'entrada') await QRCodeService.render(`${target}-qr`,receipt.numero,{ size:94 });
    }
    async function print(target, width) {
        const receipt = receipts.get(target);
        if (!receipt) return window.notify?.('Comprovante indisponível. Abra novamente a operação.','error');
        width = width === '58' ? '58' : '80';
        // Área útil conservadora para evitar depender de impressão até a borda da bobina.
        const printableWidth = width === '58' ? 48 : 72;
        localStorage.setItem('receiptWidth',width);
        const popup = window.open('','_blank','width=480,height=650');
        if (!popup) return window.notify?.('Permita abrir a janela de impressão neste navegador.','error');
        popup.document.open();
        // Apenas HTML gerado pelo renderizador com escape; sem scripts no documento impresso.
        popup.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${titles[receipt.tipo]}</title><style>${style}\nbody{margin:0 auto;width:${printableWidth}mm}.receipt{max-width:${printableWidth}mm}</style></head><body>${html(receipt,'print-qr')}</body></html>`);
        popup.document.close();
        try {
            if (receipt.tipo === 'entrada') {
                const source = document.querySelector(`#${target}-qr canvas`);
                const imgSource = document.querySelector(`#${target}-qr img`);
                const url = source?.toDataURL('image/png') || imgSource?.src;
                if (!url) throw new Error('Aguarde a geração do QR Code antes de imprimir');
                const img = popup.document.createElement('img'); img.alt = 'QR Code do ticket'; img.src = url;
                popup.document.getElementById('print-qr').append(img); await img.decode();
            }
            await popup.document.fonts.ready;
            const height = Math.max(35, Math.ceil(popup.document.body.getBoundingClientRect().height * 25.4 / 96) + 3);
            const pageStyle = popup.document.createElement('style');
            pageStyle.textContent = `@page{size:${width}mm ${height}mm;margin:0}`;
            popup.document.head.append(pageStyle);
            popup.onafterprint = () => popup.close(); popup.focus(); popup.print();
        } catch (error) { popup.close(); window.notify?.(error.message,'error'); }
    }
    function bind() {
        document.querySelectorAll('[data-receipt-print]').forEach(button => button.addEventListener('click',() => print(button.dataset.receiptPrint,button.closest('.print-controls').querySelector('select').value)));
        document.querySelectorAll('.receipt-width').forEach(select => { select.value = localStorage.getItem('receiptWidth') === '58' ? '58':'80'; select.addEventListener('change',() => { localStorage.setItem('receiptWidth',select.value); document.querySelectorAll('.receipt-width').forEach(other => { other.value=select.value; }); }); });
    }
    window.ReceiptService = { render,print,bind,clear:() => receipts.clear() };
})();
