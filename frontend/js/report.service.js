(function(){
    const el=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const money=value=>Number(value||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
    let historySequence=0,financeSequence=0,printHtml='';
    async function request(path){const actor=AuthService.user;const res=await AuthService.fetch(`${window.BACKEND_BASE}${path}`);const data=await res.json().catch(()=>({}));if(actor!==AuthService.user)throw Error('Sessão encerrada');if(!res.ok||!data.success)throw Error(data.error||'Não foi possível gerar o relatório');return data;}
    const paramsFrom=map=>{const p=new URLSearchParams();for(const [key,id]of Object.entries(map)){const value=el(id)?.value;if(value)p.set(key,value);}return p;};
    const historyParams=()=>paramsFrom({dataInicio:'filtroDataInicio',dataFim:'filtroDataFim',criterio:'filtroCriterio',placa:'filtroPlaca',status:'filtroSituacao',operador:'filtroOperador',dia:'filtroDia',mes:'filtroMes',ano:'filtroAno',tipo:'filtroTipo'});
    const financeParams=()=>paramsFrom({dataInicio:'dataInicioCaixa',dataFim:'dataFimCaixa',origem:'relatorioOrigem',forma:'relatorioForma',turno_id:'relatorioTurno',operador_id:'relatorioOperador',placa:'relatorioPlaca'});
    const criterion=p=>[...p.entries()].map(([k,v])=>`${({dataInicio:'De',dataFim:'Até',criterio:'Data de',placa:'Placa',status:'Situação',operador:'Operador',dia:'Dia',mes:'Mês',ano:'Ano',tipo:'Categoria',origem:'Origem',forma:'Meio',turno_id:'Turno',operador_id:'Operador'})[k]||k}: ${v}`).join(' · ')||'Todo o período';
    const pager=(p,kind)=>`<div class="report-pagination"><button data-report-page="${p.pagina-1}" data-report-kind="${kind}" ${p.pagina<=1?'disabled':''}>Anterior</button><span>Página ${p.pagina} de ${p.paginas} · ${p.total} registros</span><button data-report-page="${p.pagina+1}" data-report-kind="${kind}" ${p.pagina>=p.paginas?'disabled':''}>Próxima</button></div>`;
    const cards=entries=>'<div class="resumo-financeiro">'+entries.map(([title,value])=>`<div class="resumo-card"><h4>${esc(title)}</h4><p>${esc(value)}</p></div>`).join('')+'</div>';
    async function vehicles(page=1){
        page=typeof page==='number'?page:1;const seq=++historySequence,p=historyParams(),filterLabel=criterion(p);p.set('pagina',page);p.set('limite',30);el('historicoConteudo').textContent='Carregando permanências…';
        try{const data=await request(`/historico?${p}`);if(seq!==historySequence)return;
            let html=`<h4>Histórico de permanências · data de ${esc(data.criterio)}</h4><p>${esc(filterLabel)}</p><p>O valor da permanência reúne os pagamentos associados ao veículo; receita por data de recebimento é consultada no relatório financeiro.</p><div class="cash-table-scroll"><table><tr><th>Placa / categoria</th><th>Entrada</th><th>Saída / tempo</th><th>Total da permanência</th><th>Situação / operador</th><th>Comprovantes</th></tr>`;
            for(const r of data.dados)html+=`<tr><td>${esc(r.placa)}<br>${r.mensalista?'Mensalista':r.diarista?'Período':'Avulso'}</td><td>${esc(r.data_entrada)} ${esc(r.hora_entrada)}</td><td>${esc(r.data_saida||'-')} ${esc(r.hora_saida||'')}<br>${esc(r.tempo_permanencia||'')}</td><td>${money(r.valor_pago)}</td><td>${esc(r.status)}<br>${esc(r.operador_entrada||'Legado')}</td><td>${r.operacao_id?`<button data-operation-receipt="${esc(r.operacao_id)}">Saída</button>`:''}${r.diaria_operacao_id?`<button data-operation-receipt="${esc(r.diaria_operacao_id)}">Período pago</button>`:''}</td></tr>`;
            el('historicoConteudo').innerHTML=html+'</table></div>'+pager(data.paginacao,'vehicles');
        }catch(error){if(seq===historySequence)el('historicoConteudo').textContent=error.message;}
    }
    async function summary(){
        const seq=++historySequence;el('historicoConteudo').textContent='Carregando indicadores…';
        try{const data=await request(`/relatorio/resumo?${historyParams()}`);if(seq!==historySequence)return;const r=data.dados;
            el('historicoConteudo').innerHTML=`<h4>Resumo do período</h4><p>${esc(criterion(historyParams()))}</p><p>Movimento por data de ${esc(data.criterio.operacional)}; receita por data do recebimento. Fundo, sangrias e suprimentos não integram receita. Situação e operador de entrada filtram os movimentos; receita usa período, placa e categoria. Situação do pátio corresponde aos registros filtrados no momento da consulta.</p>`+cards([
                ['Receita recebida',money(r.receita_total)],['Recebimentos / parcelas',`${r.recebimentos} / ${r.parcelas}`],['Mensalidades',money(r.mensalidades)],['Períodos pré-pagos',money(r.diarias)],['Média por recebimento',money(r.valor_medio)],
                ['Permanências',r.total_movimentacoes],['Saídas / sem cobrança',`${r.total_saidas} / ${r.saidas_sem_cobranca}`],['Cancelamentos',r.cancelamentos],['Veículos no pátio (filtro)',r.veiculos_no_patio],['Permanência média (saídas)',`${(Number(r.permanencia_media_segundos)/3600).toFixed(1)} h`]]);
        }catch(error){if(seq===historySequence)el('historicoConteudo').textContent=error.message;}
    }
    async function financial(page=1){
        page=typeof page==='number'?page:1;const seq=++financeSequence,p=financeParams(),filterLabel=criterion(p);p.set('pagina',page);p.set('limite',30);el('relatorioCaixaConteudo').textContent='Carregando recebimentos…';printHtml='';
        try{const data=await request(`/relatorios/financeiro?${p}`);if(seq!==financeSequence)return;const s=data.resumo;
            let html=`<h4>Recebimentos por data de pagamento</h4><p>${esc(filterLabel)}</p><p>${esc(data.criterio)}. Filtro por meio soma somente as parcelas desse meio. Registros antigos sem operação identificada são contados individualmente.</p>`+cards([
                ['Total recebido',money(s.total)],['Recebimentos / parcelas',`${s.recebimentos} / ${s.parcelas}`],['Saídas / atrasos',money(s.saidas)],['Períodos pré-pagos',money(s.diarias)],['Mensalidades',money(s.mensalidades)],['Dinheiro',money(s.dinheiro)],['Pix',money(s.pix)],['Crédito',money(s.credito)],['Débito',money(s.debito)]]);
            html+='<div class="cash-table-scroll"><table><tr><th>Data / origem</th><th>Placa / cliente</th><th>Responsável / turno</th><th>Meios de pagamento</th><th>Total</th><th>Comprovante</th></tr>';
            for(const r of data.dados)html+=`<tr><td>${esc(r.data_ref)}<br>${esc(r.origem==='diaria'?'Período':r.origem)}</td><td>${esc(r.placa)}<br>${esc(r.cliente)}</td><td>${esc(r.operador||'Legado')}<br>${esc(r.turno_id||'-')}</td><td>${r.pagamentos.map(p=>`${esc(p.forma||'Não informado')}: ${money(p.valor)}`).join('<br>')}</td><td>${money(r.total)}</td><td>${r.operacao_id?`<button data-operation-receipt="${esc(r.operacao_id)}">Reimprimir</button>`:'Legado'}</td></tr>`;
            html+='</table></div>';printHtml=html+`<p>Página ${data.paginacao.pagina} de ${data.paginacao.paginas}. Totais correspondem ao filtro completo; linhas correspondem a esta página. Use o CSV para exportar todas as linhas.</p>`;
            el('relatorioCaixaConteudo').innerHTML=html+pager(data.paginacao,'financial');
        }catch(error){if(seq===financeSequence)el('relatorioCaixaConteudo').textContent=error.message;}
    }
    async function receivables(page=1){
        const seq=++financeSequence,p=financeParams();p.delete('origem');p.delete('forma');p.delete('turno_id');p.delete('operador_id');p.set('pagina',page);p.set('limite',30);printHtml='';
        try{const data=await request(`/relatorios/receber?${p}`);if(seq!==financeSequence)return;
            let html=`<h4>Cobranças emitidas em aberto · data do vencimento da cobrança</h4><p>${esc(criterion(p))}</p><p>${esc(data.criterio)}</p>${cards([['Saldo a receber',money(data.resumo.saldo)],['Cobranças',data.resumo.total]])}<div class="cash-table-scroll"><table><tr><th>Cobrança</th><th>Cliente / plano</th><th>Vencimento</th><th>Total / recebido / saldo</th><th>Situação</th></tr>`;
            for(const r of data.dados)html+=`<tr><td>#${esc(r.id)}</td><td>${esc(r.nome)} · ${esc(r.placa)}<br>${esc(r.plano)}</td><td>${esc(r.vencimento)}</td><td>${money(r.total)} / ${money(r.pago)} / ${money(r.saldo)}</td><td>${esc(r.estado)} · contrato ${esc(r.contrato_estado)}</td></tr>`;
            el('relatorioCaixaConteudo').innerHTML=html+'</table></div>'+pager(data.paginacao,'receivables');
        }catch(error){el('relatorioCaixaConteudo').textContent=error.message;}
    }
    async function auditLog(page=1){
        const seq=++historySequence,p=historyParams();p.set('pagina',page);p.set('limite',30);if(el('filtroAcao').value)p.set('acao',el('filtroAcao').value);
        try{const data=await request(`/auditoria?${p}`);if(seq!==historySequence)return;
            let html=`<h4>Auditoria por data do registro</h4><p>Filtros aplicados: período, dia, mês, ano, nome do operador e ação.</p><div class="cash-table-scroll"><table><tr><th>Quando</th><th>Responsável</th><th>Ação</th><th>Detalhes preservados</th></tr>`;
            for(const r of data.dados)html+=`<tr><td>${esc(new Date(r.criado_em).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}))}</td><td>${esc(r.usuario_nome||'Legado')}</td><td>${esc(r.acao)}</td><td><details><summary>Ver detalhes</summary><pre>${esc(JSON.stringify(r.detalhes,null,2))}</pre></details></td></tr>`;
            el('historicoConteudo').innerHTML=html+'</table></div>'+pager(data.paginacao,'auditLog');
        }catch(error){el('historicoConteudo').textContent=error.message;}
    }
    async function download(path,name){
        try{const res=await AuthService.fetch(`${window.BACKEND_BASE}${path}`);if(!res.ok){const data=await res.json();throw Error(data.error||'Não foi possível exportar');}
            const blob=await res.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
        }catch(error){notify(error.message,'error',7000);}
    }
    function clearFilters(){for(const id of ['filtroDataInicio','filtroDataFim','filtroPlaca','filtroSituacao','filtroOperador','filtroAcao','filtroDia','filtroMes','filtroAno','filtroTipo'])el(id).value='';el('filtroCriterio').value='entrada';return vehicles();}
    function print(){
        if(!printHtml)return notify('Gere o relatório de recebimentos antes de imprimir.','error');
        const popup=window.open('','_blank','width=1000,height=750');if(!popup)return notify('Permita abrir a janela de impressão.','error');
        popup.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de recebimentos</title><style>body{font:12px Arial;color:#111;margin:12mm}table{border-collapse:collapse;width:100%}td,th{border:1px solid #aaa;padding:5px;text-align:left}.resumo-financeiro{display:flex;flex-wrap:wrap;gap:12px}.resumo-card h4,.resumo-card p{margin:5px}button{display:none}pre{white-space:pre-wrap}@page{size:A4 landscape;margin:8mm}</style></head><body><h2>Estacionamento · Relatório de recebimentos</h2><p>Impresso em ${esc(new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}))}</p>${printHtml}</body></html>`);popup.document.close();popup.focus();popup.print();
    }
    function bind(){
        document.body.addEventListener('click',event=>{const b=event.target.closest('[data-report-page]');if(b&&!b.disabled)({vehicles,financial,receivables,auditLog})[b.dataset.reportKind]?.(Number(b.dataset.reportPage));});
        el('btnExportarHistorico').addEventListener('click',()=>download(`/relatorios/historico.csv?${historyParams()}`,'permanencias.csv'));
        el('btnExportarFinanceiro').addEventListener('click',()=>download(`/relatorios/financeiro.csv?${financeParams()}`,'recebimentos.csv'));
        el('btnImprimirRelatorio').addEventListener('click',print);el('btnVerAuditoria').addEventListener('click',()=>auditLog());el('btnRelatorioReceber').addEventListener('click',()=>receivables());
    }
    function clear(){historySequence++;financeSequence++;printHtml='';}
    window.ReportService={bind,clear,vehicles,summary,financial,receivables,auditLog,download,clearFilters,search:()=>{el('filtroPlaca').focus();vehicles();}};
})();
