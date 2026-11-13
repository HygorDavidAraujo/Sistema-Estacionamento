(function(){
    const el=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    let maintenance=false,stateKnown=false,cloudSelection=null,checking=false;
    const key=actor=>`parkingPendingOperations:${actor.id}`;
    const read=()=>{try{return JSON.parse(localStorage.getItem(key(AuthService.user)))||[];}catch{return [];}};
    const stamp=value=>value?new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'Ainda não registrado';
    function pendingUI(){
        const container=el('pendingOperations');if(!container||!AuthService.user){if(container)container.hidden=true;return;}
        const records=read();container.hidden=!records.length;
        container.innerHTML='<strong>Confirmações pendentes de conferência</strong><p>Não receba novamente antes de consultar o resultado. Repetir a mesma confirmação usa a referência original.</p>'+records.map(row=>`<p>${esc(row.label)} · ${esc(stamp(row.criado_em))} · ${esc(row.id)} <button data-pending-check="${esc(row.id)}">Consultar</button><button data-pending-retry="${esc(row.id)}">Repetir mesma confirmação</button></p>`).join('');
    }
    function remember(url,options,actor){
        if(!actor||String(options.method||'GET').toUpperCase()!=='POST'||typeof options.body!=='string')return null;
        let path;try{path=new URL(url,location.href).pathname.replace(/^\/api(?=\/)/,'');}catch{return null;}
        if(!['/saida','/entrada','/mensalistas/pagamentos'].includes(path)&&!path.startsWith('/caixa/'))return null;
        let body;try{body=JSON.parse(options.body);}catch{return null;}
        if(!body.operacao_id||path==='/entrada'&&!body.diarista)return null;
        if(!navigator.onLine)throw Error('Sem conexão: nenhuma cobrança foi confirmada. Aguarde a conexão para tentar novamente.');
        if(maintenance)throw Error('A operação está em manutenção. Aguarde a liberação do administrador.');
        if(!stateKnown)throw Error('Atualize a conexão para conferir a disponibilidade antes de confirmar a operação.');
        const id=body.operacao_id,records=read(),old=records.find(row=>row.id===id);
        if(old&&old.body!==options.body)throw Error('Esta confirmação está pendente com outros dados. Consulte o resultado original antes de alterar o pagamento.');
        if(!old){if(records.length>=20)throw Error('Confira as confirmações pendentes antes de iniciar outra.');records.push({id,path,body:options.body,criado_em:new Date().toISOString(),label:path==='/saida'?'Saída':path==='/entrada'?'Diária antecipada':path==='/mensalistas/pagamentos'?'Mensalidade':'Operação de caixa'});}
        localStorage.setItem(key(actor),JSON.stringify(records));pendingUI();return id;
    }
    function resolvePending(id){if(!AuthService.user)return;localStorage.setItem(key(AuthService.user),JSON.stringify(read().filter(r=>r.id!==id)));pendingUI();}
    async function request(path,method='GET',body){
        const actor=AuthService.user,res=await AuthService.fetch(`${window.BACKEND_BASE}${path}`,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
        const data=await res.json().catch(()=>({}));if(actor!==AuthService.user)throw Error('Sessão encerrada');if(!res.ok||!data.success)throw Object.assign(Error(data.error||'Não foi possível consultar a operação'),{status:res.status});return data;
    }
    function apply(){
        const offline=!navigator.onLine,banner=el('operationBanner');banner.hidden=!maintenance&&!offline&&stateKnown;
        banner.textContent=offline?'Sem conexão. O pátio exibido pode estar desatualizado. Nenhum novo recebimento é confirmado sem o servidor.':maintenance?'Operação em manutenção. Atendimentos suspensos até a conferência do administrador.':stateKnown?'':'Conferindo disponibilidade da operação…';
        if(!offline&&!maintenance&&!stateKnown){banner.textContent='Não foi possível confirmar a disponibilidade da operação. ';const retry=document.createElement('button');retry.textContent='Atualizar conexão';retry.onclick=()=>window.onSessionStarted?.();banner.append(retry);}
        for(const id of ['btnEntrada','btnSaida','btnTurnoCaixa','btnFecharCaixa','btnMovimentarCaixa'])if(el(id)){
            if(maintenance||offline||!stateKnown){el(id).dataset.operationBlocked='true';el(id).disabled=true;}
            else if(el(id).dataset.operationBlocked){delete el(id).dataset.operationBlocked;el(id).disabled=false;}
        }
    }
    async function refreshState(){
        if(!AuthService.user)return;
        try{const data=await request('/operacao/estado');const entering=!maintenance&&data.dados.manutencao;maintenance=data.dados.manutencao;stateKnown=true;
            if(entering){window.dadosPagamento=null;window.mensalidadePagamento=null;for(const id of ['entradaPopup','saidaPopup','pagamentoPopup','mensalidadePagamentoPopup','fechamentoCaixaPopup'])el(id)?.setAttribute('aria-hidden','true');}
        }catch{stateKnown=false;}apply();pendingUI();
    }
    async function mode(active,motivo){await request('/operacao/manutencao','POST',{ativo:active,motivo});await refreshState();}
    async function load(){
        try{const {dados:d}=await request('/operacao/status');
            el('operacaoResumo').innerHTML=`<p><strong>Banco disponível</strong> · versão ${esc(d.schema)} · ${esc(stamp(d.agora))}</p><p>Operação: ${d.manutencao.manutencao?'suspensa para manutenção':'liberada'} · ${d.operacao.patio} veículos no pátio · ${d.operacao.diferencas_pendentes} diferenças de caixa pendentes</p><p>Armazenamento privado: ${d.backup.armazenamento?'configurado':'pendente'} · Chave de cifragem: ${d.backup.chave?'configurada':'pendente'} · Agendamento: ${d.backup.automatico?'configurado':'pendente ou desativado'}</p><p>Último backup verificado: ${esc(stamp(d.ultimo_backup?.verificado_em))}${d.backup_atrasado?' · É necessário conferir uma cópia recente.':''}</p>`;
            el('operacaoAtivar').disabled=d.manutencao.manutencao;el('operacaoLiberar').disabled=!d.manutencao.manutencao;el('operacaoBackup').disabled=!d.backup.configurado;
            let html='<table><tr><th>Quando / origem</th><th>Situação</th><th>Verificação</th><th>Ações</th></tr>';
            for(const row of d.execucoes)html+=`<tr><td>${esc(stamp(row.criado_em))}<br>${esc(row.origem)}</td><td>${esc(row.estado)}${row.erro_codigo?` · ${esc(row.erro_codigo)}`:''}</td><td>${esc(stamp(row.verificado_em))}</td><td>${row.arquivo?`<button data-backup-download="${esc(row.id)}">Baixar cifrado</button><button data-backup-verify="${esc(row.id)}">Verificar novamente</button>${row.estado==='concluido'?`<button data-backup-restore="${esc(row.id)}">Restaurar dados operacionais</button>`:''}`:'Arquivo ainda não disponível'}</td></tr>`;
            el('operacaoBackups').innerHTML=html+'</table>';
            el('operacaoRetornos').innerHTML=d.pontos_retorno.map(row=>`<p>${esc(stamp(row.criado_em))} <button data-return-download="${esc(row.id)}">Baixar cópia anterior</button></p>`).join('')||'<p>Nenhuma restauração realizada.</p>';
        }catch(error){el('operacaoResumo').textContent=error.message;}
    }
    async function open(){el('menu').setAttribute('aria-hidden','true');el('operacaoPopup').setAttribute('aria-hidden','false');await load();}
    async function receipt(result){
        const r=result.comprovante;if(!r)return notify('A operação já foi confirmada no servidor. Atualize o painel para conferir.','success');
        const target=({entrada:'comprovanteEntrada',saida:'comprovantePermanencia',mensalidade:'comprovanteMensalidade'})[r.tipo]||'comprovanteCaixa';
        await ReceiptService.render(target,r);openPopup(`${target}Popup`);notify('Confirmação localizada no servidor. O recebimento não foi repetido.','success');
    }
    async function recoverPending(id,retry=false){
        if(checking)return;const record=read().find(r=>r.id===id);if(!record)return;checking=true;
        try{
            let result;try{result=(await request(`/operacoes/${encodeURIComponent(id)}${record.path.startsWith('/caixa/')?'?grupo=caixa':''}`)).dados;}catch(error){if(error.status!==404)throw error;if(!retry)throw Error('O servidor ainda não registra esta confirmação. Use “Repetir mesma confirmação” para reenviar com a referência original.');}
            if(!result)result=await request(record.path,'POST',JSON.parse(record.body));resolvePending(id);await receipt(result);await window.onSessionStarted?.();
        }catch(error){notify(error.message,'error',8000);}finally{checking=false;}
    }
    async function downloadReturn(id){const data=await request(`/operacao/restauracoes/${id}/arquivo`);const url=URL.createObjectURL(new Blob([JSON.stringify(data.dados)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`antes-da-restauracao-${id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
    async function buttons(event){
        const b=event.target.closest('button');if(!b)return;
        try{
            if(b.dataset.pendingCheck)return recoverPending(b.dataset.pendingCheck);
            if(b.dataset.pendingRetry)return recoverPending(b.dataset.pendingRetry,true);
            if(b.dataset.backupDownload)return ReportService.download(`/operacao/backups/${b.dataset.backupDownload}/arquivo`,`backup-cifrado-${b.dataset.backupDownload}.json`);
            if(b.dataset.returnDownload)return downloadReturn(b.dataset.returnDownload);
            if(b.dataset.backupVerify){b.disabled=true;await request(`/operacao/backups/${b.dataset.backupVerify}/verificar`,'POST',{});await load();notify('Cópia externa verificada.','success');}
            if(b.dataset.backupRestore){cloudSelection=b.dataset.backupRestore;el('operacaoRestaurarNuvem').hidden=false;el('restoreCloudForm').reset();el('restoreCloudMotivo').focus();}
        }catch(error){notify(error.message,'error',7000);}finally{b.disabled=false;}
    }
    function bind(){
        el('btnOperacao').addEventListener('click',open);el('operacaoAtualizar').addEventListener('click',load);
        for(const [id,active]of [['operacaoAtivar',true],['operacaoLiberar',false]])el(id).addEventListener('click',async()=>{try{await mode(active,el('operacaoMotivo').value);await load();if(!active)await window.onSessionStarted?.();}catch(error){notify(error.message,'error');}});
        el('operacaoBackup').addEventListener('click',async()=>{const b=el('operacaoBackup');b.disabled=true;try{await request('/operacao/backups','POST',{});await load();notify('Backup externo cifrado e verificado.','success');}catch(error){notify(error.message,'error',8000);}finally{b.disabled=false;}});
        document.body.addEventListener('click',buttons);
        el('restoreCloudForm').addEventListener('submit',async event=>{event.preventDefault();if(!cloudSelection)return;const b=el('restoreCloudSubmit');b.disabled=true;
            try{await mode(true,el('restoreCloudMotivo').value);await request(`/operacao/backups/${cloudSelection}/restaurar`,'POST',{confirmacao:el('restoreCloudConfirmacao').value,senha:el('restoreCloudSenha').value});el('restoreCloudForm').reset();el('operacaoRestaurarNuvem').hidden=true;cloudSelection=null;await load();await window.onSessionStarted?.();notify('Dados restaurados. Confira o pátio e os recebimentos antes de liberar.','success',8000);}catch(error){notify(error.message,'error',8000);}finally{el('restoreCloudSenha').value='';b.disabled=false;}});
        el('btnRecuperarAcesso').addEventListener('click',()=>{el('recoveryForm').reset();el('recoveryMessage').textContent='';el('recoveryPopup').setAttribute('aria-hidden','false');el('recoveryLogin').focus();});
        el('recoveryForm').addEventListener('submit',async event=>{event.preventDefault();const b=el('recoverySubmit');b.disabled=true;try{const data=await request('/auth/recovery','POST',{login:el('recoveryLogin').value,codigo:el('recoveryCodigo').value,nova_senha:el('recoverySenha').value});el('recoveryForm').reset();el('recoveryPopup').setAttribute('aria-hidden','true');el('btnRecuperarAcesso').hidden=true;el('authMessage').textContent=data.mensagem;}catch(error){el('recoveryMessage').textContent=error.message;}finally{el('recoveryCodigo').value='';el('recoverySenha').value='';b.disabled=false;}});
        for(const event of ['online','offline'])window.addEventListener(event,()=>{apply();if(navigator.onLine&&AuthService.user)refreshState();});
        document.addEventListener('keydown',event=>{if(!AuthService.user||maintenance||!navigator.onLine||document.querySelector('.popup[aria-hidden="false"]'))return;const id={F2:'btnEntrada',F4:'btnSaida',F6:'btnMensalistas',F8:'btnTurnoCaixa'}[event.key];if(id&&!el(id).hidden){event.preventDefault();el(id).click();}});
        for(const [id,shortcut]of [['btnEntrada','F2'],['btnSaida','F4'],['btnMensalistas','F6'],['btnTurnoCaixa','F8']])el(id).title=`Atalho: ${shortcut}`;
    }
    function clear(){maintenance=false;stateKnown=false;cloudSelection=null;for(const k of Object.keys(localStorage))if(k.startsWith('parkingPendingOperations:'))localStorage.removeItem(k);for(const id of ['operationBanner','pendingOperations']){el(id).hidden=true;el(id).replaceChildren();}for(const id of ['operacaoResumo','operacaoBackups','operacaoRetornos','operacaoMessage'])el(id)?.replaceChildren();}
    window.OperationService={bind,remember,resolvePending,refreshState,mode,open,apply,clear,pendingUI,get maintenance(){return maintenance;}};
})();
