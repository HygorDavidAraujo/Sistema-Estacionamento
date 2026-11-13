(function(){
    let current=null,available=false,pending=null,masked=true,openingKey=null,closing=null,movementKey=null,decision=null;
    const el=id=>document.getElementById(id);
    const manager=()=>['supervisor','administrador'].includes(AuthService.user?.perfil);
    const finance=()=>manager()||AuthService.user?.perfil==='financeiro';
    const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const money=value=>Number(value||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
    const dt=value=>value?new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'-';
    const show=id=>{document.activeElement?.blur();document.querySelectorAll('.popup').forEach(p=>p.setAttribute('aria-hidden',p.id===id?'false':'true'));el(id)?.querySelector('button,input,select,textarea')?.focus();};
    const row=(name,value)=>`<p><span>${escape(name)}</span><strong>${escape(value)}</strong></p>`;
    async function request(path,body){
        const res=await AuthService.fetch(`${window.BACKEND_BASE}${path}`,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
        const data=await res.json().catch(()=>({}));if(!res.ok||!data.success)throw Object.assign(new Error(data.error||'Não foi possível consultar o caixa'),{status:res.status});return data;
    }
    function render(){
        const summary=current?.resumo;
        el('turnoStatus').textContent=!available?'Indisponível':current?`Aberto · #${current.id}`:'Fechado';
        el('turnoInicio').textContent=current?`${current.operador_nome} · ${dt(current.aberto_em)}`:available?'Abra um turno para receber pagamentos.':'Atualize para conferir a conexão.';
        el('caixaContent').hidden=Boolean(current&&!summary);
        const fields={caixaTotalRecebido:'total_recebido',caixaDinheiro:'total_dinheiro',caixaCredito:'total_credito',caixaDebito:'total_debito',caixaPix:'total_pix',caixaFundo:'fundo_inicial',caixaSuprimentos:'suprimentos',caixaSangrias:'sangrias',caixaSaldoEsperado:'saldo_esperado'};
        for(const [id,key]of Object.entries(fields)){el(id).dataset.valor=summary?.[key]??0;el(id).textContent=masked?'R$ ••••••':money(summary?.[key]);}
        el('caixaTransacoes').textContent=summary?.total_transacoes||0;
        el('btnFecharCaixa').disabled=!available||!current?.pode_fechar;
        el('btnMovimentarCaixa').disabled=!available||!current||!current.pode_operar&&!manager();
        el('btnRelatoriosCaixa').hidden=!finance();
        const status=current?row('Turno',`#${current.id} · ${current.operador_nome}`)+row('Abertura',dt(current.aberto_em))+(summary?row('Fundo inicial',money(summary.fundo_inicial))+row('Recebimentos',money(summary.total_recebido))+row('Dinheiro esperado na gaveta',money(summary.saldo_esperado)):'<p>O recebimento está reservado ao responsável deste turno.</p>'):'<p>Nenhum turno está aberto.</p>';
        el('turnoResumo').innerHTML=status;
        el('turnoAberturaFields').hidden=Boolean(current);
        el('confirmarAberturaTurnoBtn').disabled=!available||Boolean(current);
        el('confirmarFechamentoTurnoBtn').disabled=!current?.pode_fechar;
    }
    async function refresh(){
        if(pending)return pending;
        pending=(async()=>{try{const data=await request('/caixa/turnos/atual');current=data.dados;available=true;el('cashMessage').textContent=[data.legados_abertos?`${data.legados_abertos} turno(s) antigo(s) aguardam encerramento administrativo no histórico.`:'',data.pendencias?`${data.pendencias} conferência(s) aguardam aprovação de diferença.`:''].filter(Boolean).join(' ');render();return current;}catch(error){current=null;available=false;el('cashMessage').textContent=error.message;render();return null;}finally{pending=null;}})();
        return pending;
    }
    async function requireOwnShift(){await refresh();if(!available)throw Error('Não foi possível conferir o caixa. Tente atualizar.');if(!current?.pode_operar){show('turnoCaixaPopup');if(!current)openingKey=crypto.randomUUID();throw Error(current?'O caixa está sob responsabilidade de outro operador. Faça a troca de turno.':'Abra seu turno de caixa antes de receber ou liberar a saída.');}return current;}
    async function open(){await refresh();openingKey=crypto.randomUUID();el('turnoFundoInicial').value='0.00';el('turnoObservacao').value='';show('turnoCaixaPopup');}
    async function receipt(data){await ReceiptService.render('comprovanteCaixa',data);show('comprovanteCaixaPopup');}
    async function busy(id,fn){const button=el(id);if(button.disabled)return;button.disabled=true;try{await fn();}catch(error){notify(error.message,'error',7000);}finally{button.disabled=false;render();}}
    async function openShift(){return busy('confirmarAberturaTurnoBtn',async()=>{
        const data=await request('/caixa/turnos/abrir',{fundo_inicial:el('turnoFundoInicial').value,observacao:el('turnoObservacao').value,operacao_id:openingKey||=crypto.randomUUID()});
        await refresh();await receipt(data.comprovante);notify('Turno aberto. O caixa está sob sua responsabilidade.','success');
    });}
    async function openClose(){
        try{await refresh();if(!current?.pode_fechar)throw Error('Não há turno disponível para sua conferência.');const data=await request(`/caixa/turnos/${current.id}/resumo`);const s=data.dados.resumo;if(!s)throw Error('O turno já foi encerrado.');
            closing={id:current.id,revisao:s.revisao,key:crypto.randomUUID(),summary:s};
            el('fechamentoResumo').innerHTML=row('Responsável',current.operador_nome)+row('Fundo inicial',money(s.fundo_inicial))+row('Recebimentos',money(s.total_recebido))+row('Suprimentos / sangrias',`${money(s.suprimentos)} / ${money(s.sangrias)}`)+row('Dinheiro esperado',money(s.saldo_esperado))+row('Pix / crédito / débito',`${money(s.total_pix)} / ${money(s.total_credito)} / ${money(s.total_debito)}`);
            for(const key of ['Dinheiro','Credito','Debito','Pix'])el(`contagem${key}`).value='';el('fechamentoObservacao').value='';show('fechamentoCaixaPopup');
        }catch(error){notify(error.message,'error');}
    }
    async function closeShift(){if(!closing)return;return busy('confirmarFechamentoBtn',async()=>{
        const contagem={dinheiro:el('contagemDinheiro').value,credito:el('contagemCredito').value,debito:el('contagemDebito').value,pix:el('contagemPix').value};
        const data=await request('/caixa/turnos/fechar',{turno_id:closing.id,revisao:closing.revisao,contagem,motivo:el('fechamentoObservacao').value,operacao_id:closing.key});
        closing=null;await refresh();await receipt(data.comprovante);notify(data.estado==='aguardando_aprovacao'?'Turno encerrado. Diferença aguarda aprovação do supervisor.':'Turno conferido e encerrado.','success',6000);
    });}
    async function openMovement(){await refresh();if(!current||!current.pode_operar&&!manager())return notify('O turno pertence a outro operador.','error');movementKey=crypto.randomUUID();el('movimentoValor').value='';el('movimentoMotivo').value='';show('movimentoCaixaPopup');}
    async function movement(){return busy('registrarMovimentoCaixaBtn',async()=>{const data=await request('/caixa/ajustes',{turno_id:current?.id,tipo:el('movimentoTipo').value,valor:el('movimentoValor').value,motivo:el('movimentoMotivo').value,operacao_id:movementKey||=crypto.randomUUID()});await refresh();await receipt(data.comprovante);});}
    async function history(){
        const start=el('dataInicioFechamentos').value||'2000-01-01',end=el('dataFimFechamentos').value||new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
        const params=new URLSearchParams({dataInicio:start,dataFim:end});const container=el('fechamentosConteudo');container.textContent='Carregando turnos e conferências…';
        try{
            const [data,turns,consolidated]=await Promise.all([request(`/caixa/fechamentos?${params}`),request(`/caixa/turnos?${params}`),finance()?request(`/caixa/consolidado?${params}`):null]);
            let html='';if(consolidated){const s=consolidated.dados;html=`<div class="resumo-pagamento">${row('Data operacional (abertura)',`${start} a ${end}`)}${row('Turnos encerrados / pendentes',`${s.turnos} / ${s.pendentes}`)}${row('Receita dos turnos',money(s.receita))}${row('Soma das conferências: esperado / contado',`${money(s.dinheiro_esperado)} / ${money(s.dinheiro_contado)}`)}${row('Diferença em dinheiro',money(s.diferenca_dinheiro))}</div>`;}
            html+='<h4>Conferências por turno e versão</h4><div class="cash-table-scroll"><table><tr><th>Data / responsável</th><th>Turno / versão</th><th>Recebido</th><th>Diferença em dinheiro</th><th>Estado</th><th>Ações</th></tr>';
            for(const c of data.dados){const state=c.substituida_em?'Substituída por nova conferência':c.estado==='pendente'?'Aguardando aprovação':'Aprovada';html+=`<tr><td>${escape(c.data_ref)}<br>${escape(c.operador_nome)}</td><td>#${escape(c.turno_id)} / v${escape(c.versao)}</td><td>${money(c.resumo.total_recebido)}</td><td>${money(c.diferencas.dinheiro)}</td><td>${state}</td><td><button data-cash-action="print" data-key="${escape(c.comprovante.numero)}">Imprimir</button><button data-cash-action="detail" data-id="${escape(c.turno_id)}">Detalhes</button>${manager()&&!c.substituida_em?`<button data-cash-action="reopen" data-id="${escape(c.turno_id)}">Reabrir</button>`:''}${manager()&&!c.substituida_em&&c.estado==='pendente'?`<button data-cash-action="approve" data-id="${escape(c.id)}">Aprovar diferença</button>`:''}</td></tr>`;}
            html+='</table></div><h4>Turnos e registros anteriores</h4>';
            for(const shift of turns.dados){html+=`<p>#${escape(shift.id)} · ${escape(shift.operador_nome||'Registro antigo')} · ${escape(({aberto:'Aberto',fechado:'Fechado',aguardando_aprovacao:'Aguardando aprovação',legado:shift.fechado_em?'Legado encerrado':'Legado aberto'})[shift.estado]||shift.estado)} · ${escape(dt(shift.aberto_em))} <button data-cash-action="detail" data-id="${escape(shift.id)}">Detalhes</button>${shift.estado==='legado'&&!shift.fechado_em&&manager()?`<button data-cash-action="legacy" data-id="${escape(shift.id)}">Encerrar registro legado</button>`:''}</p>`;}
            if(data.legados.length){html+='<h4>Resumos diários antigos (sem conferência por turno)</h4>';for(const legacy of data.legados)html+=`<p>${escape(legacy.data_iso)} · ${money(legacy.total_recebido)} · ${escape(legacy.observacao||'')}</p>`;}
            container.innerHTML=html+'<div id="cashHistoryDetail"></div>';
        }catch(error){container.textContent=error.message;}
    }
    async function openHistory(){show('fechamentosHistoricoPopup');await history();}
    async function historyAction(event){
        const button=event.target.closest('[data-cash-action]');if(!button)return;
        try{
            if(button.dataset.cashAction==='print'){const data=await request(`/caixa/comprovantes/${encodeURIComponent(button.dataset.key)}`);return receipt(data.dados);}
            if(button.dataset.cashAction==='detail'){
                const {dados}=await request(`/caixa/turnos/${button.dataset.id}/resumo`);let html=`<h4>Detalhes do turno #${escape(button.dataset.id)}</h4>`;
                if(dados.abertura)html+=`<p><button data-cash-action="print" data-key="${escape(dados.abertura.numero)}">Imprimir abertura</button></p>`;
                html+=row('Abertura',dt(dados.turno.aberto_em))+row('Encerramento',dt(dados.turno.fechado_em))+row('Observação de abertura',dados.turno.observacao_abertura||'-')+row('Observação de fechamento',dados.turno.observacao_fechamento||'-');
                for(const movement of dados.ajustes)html+=`<p>${escape(movement.tipo)} · ${money(movement.valor)} · ${escape(movement.usuario_nome)} · ${escape(movement.motivo)} <button data-cash-action="print" data-key="${escape(movement.comprovante.numero)}">Imprimir</button></p>`;
                for(const c of dados.conferencias)html+=`<p>v${escape(c.versao)} · ${escape(c.responsavel_nome)} · ${escape(dt(c.criado_em))} · ${escape(c.motivo||'Sem diferença')} · Aprovação: ${escape(c.aprovado_nome||'Pendente')} · ${escape(c.motivo_aprovacao||'')}</p>`;
                el('cashHistoryDetail').innerHTML=html;return;
            }
            decision={action:button.dataset.cashAction,id:button.dataset.id,key:crypto.randomUUID()};el('cashDecisionTitle').textContent={approve:'Aprovar diferença',reopen:'Reabrir turno',legacy:'Encerrar registro legado'}[decision.action];el('cashDecisionMotivo').value='';show('cashDecisionPopup');
        }catch(error){notify(error.message,'error');}
    }
    async function decide(){if(!decision)return;return busy('cashDecisionConfirm',async()=>{
        const path=decision.action==='approve'?`/caixa/conferencias/${decision.id}/aprovar`:`/caixa/turnos/${decision.id}/${decision.action==='reopen'?'reabrir':'encerrar-legado'}`;
        await request(path,{motivo:el('cashDecisionMotivo').value,operacao_id:decision.key});decision=null;await refresh();await openHistory();notify('Operação registrada com justificativa.','success');
    });}
    function bind(){el('btnMovimentarCaixa').addEventListener('click',openMovement);el('registrarMovimentoCaixaBtn').addEventListener('click',movement);el('fechamentosConteudo').addEventListener('click',historyAction);el('cashDecisionConfirm').addEventListener('click',decide);el('btnAtualizarConferencia').addEventListener('click',openClose);}
    function clear(){current=null;available=false;closing=null;openingKey=null;movementKey=null;decision=null;masked=true;}
    function toggle(){masked=!masked;render();}
    window.CashService={bind,refresh,requireOwnShift,open,openShift,openClose,closeShift,openHistory,history,toggle,clear};
})();
