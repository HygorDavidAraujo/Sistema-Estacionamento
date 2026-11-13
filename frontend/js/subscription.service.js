(function(){
    const el=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const money=value=>Number(value||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}),br=value=>value?String(value).slice(0,10).split('-').reverse().join('/'):'Sem quitação';
    const labels={em_dia:'Em dia',a_vencer:'Vence em até 2 dias',vence_hoje:'Vence hoje',vencido:'Vencido',sem_pagamento:'Sem pagamento',suspenso:'Suspenso',cancelado:'Cancelado',a_iniciar:'A iniciar'};
    const manager=()=>['supervisor','administrador'].includes(AuthService.user?.perfil);
    let rows=[],page=1,quoteSequence=0,paymentBusy=false,detailCustomer=null;
    async function req(path,method='GET',body){
        const actor=AuthService.user;
        const res=await AuthService.fetch(`${window.BACKEND_BASE}${path}`,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
        const data=await res.json().catch(()=>({}));if(actor!==AuthService.user)throw Error('Sessão encerrada');if(!res.ok||!data.success)throw Error(data.error||'Não foi possível consultar os mensalistas');return data;
    }
    function clearForm(show=false){
        document.querySelector('.mensalista-form').hidden=!show;
        window.mensalistaEditId=null;
        for(const id of ['mensalistaPlaca','mensalistaNomeForm','mensalistaTelefoneForm','mensalistaCpfForm','mensalistaVencimento','mensalistaVeiculos','mensalistaMotivo'])el(id).value='';
        el('mensalistaPlano').value='Mensal';el('mensalistaValorContrato').value=Number(localStorage.getItem('valorMensalidade')||0).toFixed(2);
        el('mensalistaInicio').value=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());el('mensalistaInicio').readOnly=false;el('mensalistaEstado').value='ativo';el('mensalistaLimite').value='1';
    }
    function edit(row){
        document.querySelector('.mensalista-form').hidden=false;
        window.mensalistaEditId=row.id;
        for(const [id,key]of [['mensalistaPlaca','placa'],['mensalistaNomeForm','nome'],['mensalistaTelefoneForm','telefone'],['mensalistaCpfForm','cpf'],['mensalistaPlano','plano'],['mensalistaValorContrato','valor_mensal'],['mensalistaInicio','inicio'],['mensalistaVencimento','vencimento']])el(id).value=row[key]||'';
        el('mensalistaInicio').readOnly=true;el('mensalistaEstado').value=row.estado||'ativo';el('mensalistaLimite').value=row.limite_simultaneo||1;
        el('mensalistaVeiculos').value=(row.veiculos||[]).filter(p=>p!==row.placa).join('\n');el('mensalistaMotivo').value='';el('mensalistaNomeForm').focus();
    }
    async function save(){
        const button=el('btnSalvarMensalista');if(button.disabled)return;button.disabled=true;
        try{
            const body={placa:el('mensalistaPlaca').value,nome:el('mensalistaNomeForm').value,telefone:el('mensalistaTelefoneForm').value,cpf:el('mensalistaCpfForm').value,
                plano:el('mensalistaPlano').value,valor_mensal:el('mensalistaValorContrato').value,inicio:el('mensalistaInicio').value,estado:el('mensalistaEstado').value,limite_simultaneo:Number(el('mensalistaLimite').value),
                veiculos:el('mensalistaVeiculos').value.split(/[\s,;]+/).filter(Boolean),motivo:el('mensalistaMotivo').value};
            await req(window.mensalistaEditId?`/mensalistas/${window.mensalistaEditId}`:'/mensalistas',window.mensalistaEditId?'PUT':'POST',body);
            clearForm();await load();await alerts();notify('Cliente e contrato salvos. A quitação define a validade.','success');
        }catch(error){notify(error.message,'error',7000);}finally{button.disabled=false;}
    }
    const listParams=()=>new URLSearchParams({q:el('mensalistasBusca').value.trim(),status:el('mensalistasStatus').value,pagina:page,limite:20});
    async function load(next=1){
        page=typeof next==='number'?next:1;
        try{
            const data=await req(`/mensalistas?${listParams()}`);rows=data.dados;
            el('mensalistasResumo').textContent=`${data.resumo.total} cliente(s) · ${data.resumo.a_vencer} a vencer · ${data.resumo.vence_hoje} vencem hoje · ${data.resumo.vencidos} vencidos · Cobranças em aberto: ${money(data.resumo.saldo_aberto)}`;
            let html='<div class="cash-table-scroll"><table><thead><tr><th>Cliente / placas</th><th>Plano / 30 dias</th><th>Pago até</th><th>Situação</th><th>Ações</th></tr></thead><tbody>';
            for(const row of rows)html+=`<tr><td>${esc(row.nome)}<br>${esc((row.veiculos?.length?row.veiculos:[row.placa]).join(' / '))}</td><td>${esc(row.plano||'Legado')}<br>${money(row.valor_mensal)}</td><td>${esc(br(row.vencimento))}</td><td><span class="subscription-status ${esc(row.situacao)}">${esc(labels[row.situacao])}</span></td><td>${manager()?`<button data-edit-id="${esc(row.id)}">Editar</button>`:''}<button data-history-id="${esc(row.id)}">Contrato e histórico</button>${row.estado!=='cancelado'?`<button data-pay-id="${esc(row.id)}">Receber</button>`:''}</td></tr>`;
            el('mensalistasLista').innerHTML=html+'</tbody></table></div>'+(rows.length?'':'<p>Nenhum cliente para estes filtros.</p>');
            const p=data.paginacao;el('mensalistasPaginacao').innerHTML=`<button data-sub-page="${page-1}" ${page<=1?'disabled':''}>Anterior</button><span>Página ${page} de ${p.paginas} · ${p.total} clientes</span><button data-sub-page="${page+1}" ${page>=p.paginas?'disabled':''}>Próxima</button>`;
            AuthService.applyPermissions();
        }catch(error){el('mensalistasLista').textContent=error.message;}
    }
    async function history(customer,paymentPage=1){
        detailCustomer=customer;const container=el('mensalidadeHistoricoConteudo');container.textContent='Carregando contrato e recebimentos…';
        try{
            const [detail,payments]=await Promise.all([req(`/mensalistas/${customer.id}/financeiro`),req(`/mensalistas/${customer.id}/pagamentos?limit=100&pagina=${paymentPage}`)]);
            const {contrato:c,cobrancas:invoices,veiculos}=detail.dados;
            let html=`<h4>${esc(customer.nome)} · contrato #${esc(c.id)}</h4><p>${esc(c.plano)} · ${money(c.valor_mensal)} por 30 dias · Limite: ${esc(c.limite_simultaneo)} veículo(s) simultâneo(s)</p><p>Placas: ${esc(veiculos.join(' / '))}</p><p>Pago até: ${esc(br(c.validade))} · ${esc(labels[c.situacao])}</p>`;
            if(manager())html+=`<div class="legacy-regularization"><label for="regularizarPagoAte">Regularizar validade anterior (contrato sem cobranças)</label><input id="regularizarPagoAte" type="date" /><label for="regularizarMotivo">Justificativa</label><input id="regularizarMotivo" maxlength="255" /><button data-sub-regularize="${esc(customer.id)}">Registrar regularização sem receita</button></div>`;
            html+='<h4>Cobranças antecipadas</h4><p>A validade de cobrança não quitada é uma previsão: os 30 dias começam na quitação, preservando dias já pagos.</p><div class="cash-table-scroll"><table><tr><th>Cobrança / competência</th><th>Período previsto/quitado</th><th>Total / recebido / saldo</th><th>Situação</th><th>Ação</th></tr>';
            for(const invoice of invoices)html+=`<tr><td>#${esc(invoice.id)} · ${esc(invoice.competencia_iso.slice(0,7))}</td><td>${esc(br(invoice.inicio_iso))} a ${esc(br(invoice.fim_iso))}<br>${invoice.meses*30} dias</td><td>${money(invoice.total)} / ${money(invoice.pago)} / ${money(Number(invoice.total)-Number(invoice.pago))}</td><td>${esc(invoice.estado)}</td><td>${manager()&&invoice.estado==='aberta'?`<button data-sub-cancel="${esc(invoice.id)}">Cancelar cobrança</button>`:''}</td></tr>`;
            html+='</table></div><h4>Recebimentos (cada linha reúne seus meios de pagamento)</h4><div class="cash-table-scroll"><table><tr><th>Registro / turno</th><th>Valor e meios</th><th>Período / saldo</th><th>Comprovante</th></tr>';
            for(const op of payments.recebimentos||[]){const r=op.comprovante;html+=`<tr><td>${esc(new Date(r.emitido_em).toLocaleString('pt-BR',{timeZone:r.fuso||'America/Sao_Paulo'}))}<br>${esc(r.operador)} · #${esc(op.turno_id)}</td><td>${money(r.total)}<br>${(r.pagamentos||[]).map(p=>`${esc(p.forma_pagamento)}: ${money(p.valor_pago)}`).join('<br>')}</td><td>${r.dias?`${r.dias} dias`:`${r.meses} mês(es) · registro anterior`}<br>${r.pagamento_parcial?`Parcial · saldo ${money(r.saldo_pendente)}`:`Pago até ${esc(br(r.novo_vencimento))}`}</td><td><button data-operation-receipt="${esc(op.chave)}">Reimprimir</button></td></tr>`;}
            for(const r of payments.dados||[])html+=`<tr><td>${esc(r.data_pagamento)} ${esc(r.hora_pagamento)}</td><td>${money(r.valor_pago)} · ${esc(r.forma_pagamento)}</td><td>${esc(r.observacao||'Registro legado sem recibo original')}</td><td>Legado</td></tr>`;
            html+='</table></div>';
            if(payments.paginacao){const p=payments.paginacao;html+=`<p>Página ${p.pagina} de ${p.paginas} · ${p.total} recebimentos</p>${p.pagina>1?`<button data-sub-history-page="${p.pagina-1}">Anterior</button>`:''}${p.pagina<p.paginas?`<button data-sub-history-page="${p.pagina+1}">Próxima</button>`:''}`;}
            container.innerHTML=html;
        }catch(error){container.textContent=error.message;}
    }
    function total(){return Number(el('mensalidadeReceber').value||0);}
    function renderQuote(){
        const c=window.mensalidadePagamento,q=c?.quote;if(!q)return;
        el('mensalidadeResumo').innerHTML=`<h4>${esc(q.cliente)} · ${esc(q.plano)}</h4><p>Pago até: ${esc(br(q.pago_ate))}</p><p>${q.meses*30} dias · ${q.cobranca_id?`Cobrança #${esc(q.cobranca_id)}`:'Nova cobrança antecipada'}</p><p>Total: ${money(q.total)} · Já recebido: ${money(q.pago)} · Saldo: ${money(q.saldo)}</p><p>Receber agora: <strong>${money(total())}</strong></p><p>${total()<q.saldo?'Pagamento parcial: não libera o novo período.':'Quitação: libera o novo período.'}${q.estado==='suspenso'?' Contrato suspenso: pagamento não reativa o acesso.':''}</p>`;
        el('mensalidadeVencimentoEstimado').textContent=`Quitando hoje: validade até ${br(q.fim_periodo)}. Cada período corresponde a 30 dias corridos.`;
        updateSplitSummary('splitMensalidadeLista','splitMensalidadeTotal','splitMensalidadeRestante',total());
    }
    async function preview(initial=false){
        const current=window.mensalidadePagamento;if(!current)return;const seq=++quoteSequence;
        current.quote=null;el('confirmarMensalidadeBtn').disabled=true;el('gerarCobrancaMensalidadeBtn').disabled=true;
        try{
            const data=await req(`/mensalistas/${current.id}/cotacao`,'POST',initial?{}:{meses:Number(el('mensalidadeMeses').value)});
            if(seq!==quoteSequence||current!==window.mensalidadePagamento)return;
            current.quote=data.dados;const q=data.dados;el('mensalidadeMeses').value=q.meses;el('mensalidadeMeses').disabled=Boolean(q.cobranca_id);
            el('mensalidadeValor').value=q.valor_mensal.toFixed(2);el('mensalidadeReceber').value=q.saldo.toFixed(2);el('mensalidadeReceber').max=q.saldo;
            resetSplitUI('splitMensalidadeLista','splitMensalidadeTotal','splitMensalidadeRestante',q.saldo);renderQuote();
            el('confirmarMensalidadeBtn').disabled=false;el('gerarCobrancaMensalidadeBtn').disabled=Boolean(q.cobranca_id);
        }catch(error){notify(error.message,'error',6500);}
    }
    async function openPayment(customer){
        try{const shift=await CashService.requireOwnShift();window.mensalidadePagamento={id:customer.id,nome:customer.nome,placa:customer.placa,turno_id:shift.id,operacao_id:crypto.randomUUID(),quote:null};
            el('mensalidadeMeses').disabled=false;el('mensalidadeMeses').value='1';el('mensalidadeObservacao').value='';el('mensalidadeResumo').textContent='Consultando contrato e saldo…';openPopup('mensalidadePagamentoPopup');await preview(true);
        }catch(error){notify(error.message,'error');}
    }
    async function pay(){
        const current=window.mensalidadePagamento,q=current?.quote;if(paymentBusy||!q)return;
        const amount=total(),payments=getSplitPayments('splitMensalidadeLista');if(amount<=0||amount>q.saldo||!validateSplitTotal(amount,payments))return notify('Confira o valor recebido e as formas de pagamento.','error');
        paymentBusy=true;el('confirmarMensalidadeBtn').disabled=true;
        try{
            const result=await req('/mensalistas/pagamentos','POST',{mensalista_id:current.id,meses:q.meses,revisao:q.revisao,cobranca_id:q.cobranca_id,periodo_previsto:q.fim_periodo,valor_recebido:el('mensalidadeReceber').value,turno_id:current.turno_id,operacao_id:current.operacao_id,pagamentos:payments,observacao:el('mensalidadeObservacao').value});
            window.mensalidadePagamento=null;await ReceiptService.render('comprovanteMensalidade',result.comprovante);el('continuarSaidaMensalista').hidden=!window.saidaMensalistaPendente;closePopup('mensalidadePagamentoPopup');openPopup('comprovanteMensalidadePopup');
            await Promise.all([load(page),alerts(),CashService.refresh()]);await history(current);notify(result.comprovante.pagamento_parcial?'Parcial registrado. O novo período aguarda quitação.':'Quitação registrada. Validade atualizada.','success',6000);
        }catch(error){notify(error.message+' Em caso de queda de conexão, repita a mesma confirmação.','error',8000);}finally{paymentBusy=false;el('confirmarMensalidadeBtn').disabled=!window.mensalidadePagamento?.quote;}
    }
    async function generate(){
        const current=window.mensalidadePagamento,q=current?.quote;if(!q||paymentBusy)return;paymentBusy=true;el('gerarCobrancaMensalidadeBtn').disabled=true;
        try{await req(`/mensalistas/${current.id}/cobrancas`,'POST',{meses:q.meses,revisao:q.revisao,operacao_id:current.operacao_id});closePopup('mensalidadePagamentoPopup');openPopup('mensalistasPopup');await history(current);window.mensalidadePagamento=null;await load(page);notify('Cobrança emitida. O período será liberado somente após quitação.','success');}
        catch(error){notify(error.message,'error');}finally{paymentBusy=false;el('gerarCobrancaMensalidadeBtn').disabled=false;}
    }
    async function alerts(){
        const container=el('mensalistasAvisos');try{const data=await req('/mensalistas/avisos');container.hidden=!data.dados.length;
            container.innerHTML='<h3>Avisos de mensalidades</h3>'+data.dados.slice(0,6).map(r=>`<p><strong>${esc(labels[r.situacao])}</strong> · ${esc(r.nome)} · ${esc(r.placa)} · ${esc(br(r.vencimento))}</p>`).join('')+`<button id="verAvisosMensalistas">Ver mensalistas${data.dados.length>6?' e demais avisos':''}</button>`;
            el('verAvisosMensalistas')?.addEventListener('click',()=>{openPopup('mensalistasPopup');el('mensalistasStatus').value='';load();});
        }catch{container.hidden=false;container.textContent='Avisos de mensalistas indisponíveis. Atualize para conferir os vencimentos.';}
    }
    async function actions(event){
        const button=event.target.closest('button');if(!button)return;
        try{
            if(button.dataset.editId)return edit(rows.find(r=>String(r.id)===button.dataset.editId));
            if(button.dataset.payId)return openPayment(rows.find(r=>String(r.id)===button.dataset.payId));
            if(button.dataset.historyId)return history(rows.find(r=>String(r.id)===button.dataset.historyId));
            if(button.dataset.subPage)return load(Number(button.dataset.subPage));
            if(button.dataset.subHistoryPage)return history(detailCustomer,Number(button.dataset.subHistoryPage));
            if(button.dataset.subRegularize){await req(`/mensalistas/${button.dataset.subRegularize}/regularizar-validade`,'POST',{pago_ate:el('regularizarPagoAte').value,motivo:el('regularizarMotivo').value});await history(detailCustomer);await load(page);await alerts();return notify('Regularização registrada na auditoria, sem gerar receita.','success');}
            if(button.dataset.subCancel){const note=prompt('Justificativa do cancelamento (10 a 255 caracteres):');if(note===null)return;await req(`/mensalistas/${detailCustomer.id}/cobrancas/${button.dataset.subCancel}/cancelar`,'POST',{motivo:note});await history(detailCustomer);await load(page);}
        }catch(error){notify(error.message,'error',7000);}
    }
    function bind(){
        for(const id of ['mensalistasLista','mensalistasPaginacao','mensalidadeHistoricoConteudo'])el(id).addEventListener('click',actions);
        el('mensalidadeReceber').addEventListener('input',()=>{const fields=el('splitMensalidadeLista').querySelectorAll('.split-valor');if(fields.length===1)fields[0].value=total().toFixed(2);renderQuote();});
        el('gerarCobrancaMensalidadeBtn').addEventListener('click',generate);
        el('btnExportarMensalistas').addEventListener('click',()=>ReportService.download(`/mensalistas/exportar.csv?${listParams()}`,'mensalistas.csv'));
    }
    function clear(){rows=[];detailCustomer=null;quoteSequence++;window.mensalidadePagamento=null;window.saidaMensalistaPendente=null;el('continuarSaidaMensalista').hidden=true;el('mensalistasAvisos').hidden=true;el('mensalistasAvisos').replaceChildren();el('mensalistasResumo').textContent='';el('mensalistasPaginacao').replaceChildren();}
    window.SubscriptionService={bind,clear,clearForm,edit,save,load,history,total,preview,openPayment,pay,alerts};
})();
