import { test, expect } from '@playwright/test';
import {readFile} from 'node:fs/promises';

test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
        console.log('Estado da consulta:', await page.evaluate(() => ({
            placa: document.getElementById('placaEntrada')?.value,
            status: document.getElementById('vehicleLookupStatus')?.textContent,
            modelo: document.getElementById('modeloEntrada')?.value,
            sequence: vehicleLookupSequence
        })).catch(() => ({})));
    }
});

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { window.BACKEND_BASE = 'http://127.0.0.1:3108'; });
    await page.goto('/');
    await page.fill('#authLogin','teste');
    await page.fill('#authSenha','Senha-teste-123');
    await page.click('#authSubmit');
    await expect(page.locator('#connectionStatus')).toHaveText('Sincronizado');
    await page.evaluate(async()=>{
        const current=await (await apiFetch(`${BACKEND_BASE}/caixa/turnos/atual`)).json();
        if(!current.dados)await operationRequest('/caixa/turnos/abrir',{operacao_id:crypto.randomUUID(),fundo_inicial:0});
        await CashService.refresh();
    });
});

test('consulta preenche os três campos e mantém dados do veículo atual', async ({ page }) => {
    await expect(page.locator('#totalVagas')).toHaveText('50');
    await page.screenshot({ path: '../artifacts/central-operacao.png', animations: 'disabled', fullPage: true });
    await page.click('#btnEntrada');
    await page.fill('#placaEntrada', 'abc1d23');
    await expect(page.locator('#modeloEntrada')).toHaveValue('VEÍCULO A');
    await expect(page.locator('#marcaEntrada')).toHaveValue('MARCA TESTE');
    await expect(page.locator('#corEntrada')).toHaveValue('Cinza');
    await page.fill('#placaEntrada', 'DEF4G56');
    await expect(page.locator('#modeloEntrada')).toHaveValue('VEÍCULO B');
    await page.fill('#marcaEntrada', 'Revisado manualmente');
    await page.click('#refreshPlateBtn');
    await page.waitForTimeout(800);
    await expect(page.locator('#marcaEntrada')).toHaveValue('MARCA TESTE');
});

test('edição manual feita durante a consulta é preservada', async ({ page }) => {
    await page.route('**/placa/ABC1D23', async route => {
        await new Promise(resolve => setTimeout(resolve, 800));
        await route.fulfill({ json: { encontrado: true, marca: 'Fornecedor', modelo: 'Modelo', cor: 'Cinza' } });
    });
    await page.click('#btnEntrada');
    await page.fill('#placaEntrada', 'ABC1D23');
    await expect(page.locator('#vehicleLookupStatus')).toContainText('Consultando');
    await page.fill('#marcaEntrada', 'Marca revisada');
    await expect(page.locator('#modeloEntrada')).toHaveValue('Modelo');
    await expect(page.locator('#marcaEntrada')).toHaveValue('Marca revisada');
});

test('resposta antiga e fechamento do formulário não alteram cadastro atual', async ({ page }) => {
    let requested;
    const ready = new Promise(resolve => { requested = resolve; });
    await page.route('**/placa/ABC1D23', async route => {
        requested();
        await new Promise(resolve => setTimeout(resolve, 1600));
        await route.fulfill({ json: { encontrado: true, marca: 'ANTIGO', modelo: 'ANTIGO', cor: 'Azul' } }).catch(() => {});
    });
    await page.click('#btnEntrada');
    await page.fill('#placaEntrada', 'ABC1D23');
    await ready;
    await page.fill('#placaEntrada', 'DEF4G56');
    await expect(page.locator('#modeloEntrada')).toHaveValue('VEÍCULO B');
    await page.waitForTimeout(1800);
    await expect(page.locator('#modeloEntrada')).toHaveValue('VEÍCULO B');
    await page.fill('#placaEntrada', 'GHI7J89');
    await page.locator('#entradaPopup [data-close]').click();
    await page.waitForTimeout(700);
    await expect(page.locator('#vehicleLookupStatus')).not.toHaveAttribute('data-state', 'loading');
});

test('cota indisponível permite atendimento manual sem alertas bloqueantes', async ({ page }) => {
    await page.route('**/placa/ABC1D23', route => route.fulfill({ status: 429, json: { status: 'quota_exceeded', mensagem: 'Cota esgotada. Preencha manualmente.' } }));
    await page.click('#btnEntrada');
    await page.fill('#placaEntrada', 'ABC1D23');
    await expect(page.locator('#vehicleLookupStatus')).toContainText('Cota esgotada');
    await expect(page.locator('#registrarBtn')).toBeEnabled();
});

test('câmera inicia, fecha e cancela leituras pendentes', async ({ page }) => {
    await page.evaluate(() => {
        window.__terminated = 0;
        window.__started = false;
        // Vídeo sintético local: não depende da câmera física do computador.
        navigator.mediaDevices.getUserMedia = async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 1280; canvas.height = 720;
            const context = canvas.getContext('2d');
            const draw = () => { context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#000'; context.font = '100px monospace'; context.fillText('ABC1D23', 300, 400); };
            const stream = canvas.captureStream(10);
            const interval = setInterval(draw, 100);
            stream.getTracks()[0].addEventListener('ended', () => clearInterval(interval));
            draw();
            return stream;
        };
        window.Tesseract = { createWorker: async () => ({ setParameters: async () => {}, recognize: () => { window.__started = true; return new Promise(() => {}); }, terminate: async () => { window.__terminated++; } }) };
    });
    await page.click('#btnEntrada');
    await page.click('#scanPlacaBtn');
    await expect(page.locator('#entradaCameraStatus')).toContainText('Centralize');
    await page.click('#capturarPlacaBtn');
    await expect.poll(() => page.evaluate(() => window.__started)).toBe(true);
    await page.click('#fecharCameraEntradaBtn');
    await expect(page.locator('#cameraEntradaContainer')).toHaveAttribute('aria-hidden', 'true');
    expect(await page.evaluate(() => document.getElementById('entradaCameraPreview').srcObject)).toBeNull();
    await expect.poll(() => page.evaluate(() => window.__terminated)).toBe(1);
});

test('OCR real lê foto de teste e exige confirmação antes de preencher a entrada', async ({ page }) => {
    await page.click('#btnEntrada');
    const image = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 1200; canvas.height = 260;
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff'; context.fillRect(0, 0, 1200, 260);
        context.fillStyle = '#000'; context.font = 'bold 150px monospace';
        context.textAlign = 'center'; context.fillText('ABC1D23', 600, 185);
        return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.setInputFiles('#platePhotoInput', { name: 'placa-teste.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
    await expect(page.locator('#plateDetectedInput')).toHaveValue('ABC1D23', { timeout: 35000 });
    await expect(page.locator('#placaEntrada')).toHaveValue('');
    await page.click('#acceptPlateBtn');
    await expect(page.locator('#placaEntrada')).toHaveValue('ABC1D23');
    await expect(page.locator('#modeloEntrada')).toHaveValue('VEÍCULO A');
});

test('layout móvel mantém formulário e ações acessíveis sem rolagem horizontal', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('#btnEntrada');
    await expect(page.locator('#scanPlacaBtn')).toBeVisible();
    await expect(page.locator('label[for="platePhotoInput"]')).toBeVisible();
    const width = await page.evaluate(() => ({ screen: innerWidth, content: document.documentElement.scrollWidth }));
    expect(width.content).toBeLessThanOrEqual(width.screen);
    await page.screenshot({ path: '../artifacts/entrada-mobile.png', animations: 'disabled' });
});

test('entrada, saída e mensalidade geram comprovantes compactos de 58 e 80 mm',async({page})=>{
    await page.evaluate(()=>{
        const open=window.open.bind(window);
        window.open=(...args)=>{const child=open(...args);if(child)child.print=()=>{child.__printed=true;};return child;};
    });
    async function checkPrint(target,label,width){
        await page.locator(`#${target}`).locator('..').locator('.receipt-width').selectOption(width);
        const pending=page.waitForEvent('popup');
        await page.locator(`[data-receipt-print="${target}"]`).click();
        const popup=await pending;await popup.waitForFunction(()=>window.__printed===true);
        const metrics=await popup.evaluate(()=>{
            const receipt=document.querySelector('.receipt');
            const rules=[...document.styleSheets].flatMap(sheet=>[...sheet.cssRules]).map(rule=>rule.cssText).join('\n');
            return {width:document.body.getBoundingClientRect().width,height:document.body.getBoundingClientRect().height,overflow:receipt.scrollWidth>Math.ceil(receipt.getBoundingClientRect().width),rules,text:document.body.innerText};
        });
        expect(metrics.width).toBeCloseTo((width==='58'?48:72)*96/25.4,0);
        expect(metrics.height*25.4/96).toBeLessThan(150);
        expect(metrics.overflow).toBe(false);
        expect(metrics.rules).toContain(`size: ${width}mm`);
        expect(metrics.text).toContain('Operador: Operador de teste');
        expect(metrics.text).toContain('JKL1M23');
        // printToPDF dispara afterprint; manter a janela aberta até ler o arquivo de teste.
        await popup.evaluate(()=>{window.onafterprint=null;});
        const pdf=await popup.pdf({path:`../artifacts/comprovante-${label}-${width}mm.pdf`,preferCSSPageSize:true,printBackground:true});
        expect((pdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length).toBe(1);
        await popup.screenshot({path:`../artifacts/comprovante-${label}-${width}mm.png`,fullPage:true});
        console.log(`Comprovante ${label} ${width} mm: ${(metrics.height*25.4/96).toFixed(1)} mm de conteúdo`);
        await popup.close();
    }
    await page.click('#btnEntrada');await page.fill('#placaEntrada','JKL1M23');
    await expect(page.locator('#modeloEntrada')).not.toHaveValue('');await page.click('#registrarBtn');
    await expect(page.locator('#comprovanteEntradaPopup')).toHaveAttribute('aria-hidden','false');
    await expect(page.locator('#comprovanteEntrada .qr canvas')).toBeAttached();
    // O mesmo QR reduzido é decodificado pelo leitor real do navegador.
    await expect.poll(()=>page.evaluate(()=>{
        const canvas=document.querySelector('#comprovanteEntrada .qr canvas');const image=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height);
        return Boolean(window.jsQR?.(image.data,image.width,image.height)?.data);
    })).toBe(true);
    await checkPrint('comprovanteEntrada','entrada','80');await checkPrint('comprovanteEntrada','entrada','58');
    await page.locator('#comprovanteEntradaPopup [data-close]').click();
    await page.evaluate(async()=>{await apiFetch(`${BACKEND_BASE}/__test/prepare`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({placa:'JKL1M23',minutes:65})});});
    await page.click('#btnSaida');await page.fill('#placaSaida','JKL1M23');await page.click('#calcularBtn');
    await expect(page.locator('#pagamentoPopup')).toHaveAttribute('aria-hidden','false');
    await expect(page.locator('#splitPagamentoTotal')).toHaveText('R$ 7.50');
    await page.selectOption('#splitPagamentoLista .split-forma','Pix');await page.click('#confirmarPagamentoBtn');
    await expect(page.locator('#comprovantePermanenciaPopup')).toHaveAttribute('aria-hidden','false');
    await expect(page.locator('#comprovantePermanencia')).toContainText('7,50');
    await checkPrint('comprovantePermanencia','saida','80');await checkPrint('comprovantePermanencia','saida','58');
    await page.locator('#comprovantePermanenciaPopup [data-close]').click();
    await page.evaluate(async()=>{await apiFetch(`${BACKEND_BASE}/__test/prepare`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({placa:'JKL1M23',mensalista:true})});});
    await page.click('#btnMensalistas');await page.fill('#mensalistasBusca','JKL1M23');await page.click('#btnBuscarMensalistas');
    await page.locator('#mensalistasLista [data-pay-id]').click();await page.selectOption('#splitMensalidadeLista .split-forma','Dinheiro');await page.click('#confirmarMensalidadeBtn');
    await expect(page.locator('#comprovanteMensalidadePopup')).toHaveAttribute('aria-hidden','false');
    await expect(page.locator('#comprovanteMensalidade')).toContainText('300,00');
    await checkPrint('comprovanteMensalidade','mensalidade','80');await checkPrint('comprovanteMensalidade','mensalidade','58');
});

test('histórico exibe observação maliciosa como texto, sem executar eventos',async({page})=>{
    await page.route('**/mensalistas/99/financeiro',route=>route.fulfill({json:{success:true,dados:{contrato:{id:99,plano:'Plano teste',valor_mensal:300,limite_simultaneo:1,situacao:'sem_pagamento'},cobrancas:[],veiculos:['ABC1D23']}}}));
    await page.route('**/mensalistas/99/pagamentos?*',route=>route.fulfill({json:{success:true,dados:[{id:1,valor_pago:300,observacao:'<img src=x onerror="window.__xss=1">',forma_pagamento:'<b>Pix</b>'}]}}));
    await page.evaluate(()=>carregarHistoricoMensalidade({id:99,nome:'<script>teste</script>',placa:'ABC1D23'}));
    expect(await page.locator('#mensalidadeHistoricoConteudo img').count()).toBe(0);
    expect(await page.evaluate(()=>window.__xss)).toBeUndefined();
    expect(await page.locator('#mensalidadeHistoricoConteudo').textContent()).toContain('<img src=x');
});

test('logout encerra sessão no servidor e remove dados operacionais locais',async({page})=>{
    await page.evaluate(()=>{localStorage.setItem('parkingEntries','[{"placa":"ABC1D23"}]');localStorage.setItem('ABC1D23','{"horaEntrada":"2026-01-01"}');document.getElementById('mensalistaCpfForm').value='12345678900';});
    await page.click('#btnAuth');await expect(page.locator('body')).toHaveAttribute('data-session','locked');
    expect(await page.evaluate(()=>localStorage.getItem('parkingEntries'))).toBeNull();
    expect(await page.evaluate(()=>localStorage.getItem('ABC1D23'))).toBeNull();
    expect(await page.locator('#mensalistaCpfForm').inputValue()).toBe('');
    const status=await page.evaluate(async()=> (await fetch(`${BACKEND_BASE}/patio/ativos`,{credentials:'include'})).status);
    expect(status).toBe(401);await expect(page.locator('#btnEntrada')).toBeHidden();
});

test('administrador cria operador pela interface e suas permissões valem no servidor',async({page})=>{
    await page.click('#btnMenu');await page.click('#btnUsuarios');
    await expect(page.locator('#usuariosPopup')).toHaveAttribute('aria-hidden','false');
    await page.fill('#usuarioNome','Operador de balcão');await page.fill('#usuarioLogin','balcao');await page.fill('#usuarioSenha','Senha-balcao-123');
    await page.click('#usuarioSalvar');await expect(page.locator('#usuariosLista')).toContainText('Operador de balcão');
    await page.locator('#usuariosPopup [data-close]').click();await page.click('#btnAuth');
    await page.fill('#authLogin','balcao');await page.fill('#authSenha','Senha-balcao-123');await page.click('#authSubmit');
    await expect(page.locator('#sessionIdentity')).toContainText('Operador de balcão');await expect(page.locator('#btnMenu')).toBeHidden();
    const status=await page.evaluate(async()=> (await apiFetch(`${BACKEND_BASE}/CONFIGURACOES/`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({valor_hora_inicial:'0'})})).status);
    expect(status).toBe(403);
});

test('formulário de primeiro acesso volta a exigir somente usuário e senha depois da configuração',async({page})=>{
    await page.click('#btnAuth');await expect(page.locator('body')).toHaveAttribute('data-session','locked');
    await page.route('**/auth/status',route=>route.fulfill({json:{success:true,primeiro_acesso:true,configuracao_disponivel:true}}));
    // Backend de setup já é testado com banco real isolado. Aqui verificamos a transição do formulário.
    await page.route('**/auth/setup',async route=>{
        const login=await page.request.post('http://127.0.0.1:3108/auth/login',{data:{login:'teste',senha:'Senha-teste-123'}});
        await route.fulfill({response:login});
    });
    await page.reload();await page.fill('#authNome','Administrador de teste');await page.fill('#authCodigo','codigo-de-teste');
    await page.fill('#authLogin','teste');await page.fill('#authSenha','Senha-teste-123');await page.click('#authSubmit');
    await expect(page.locator('body')).toHaveAttribute('data-session','active');
    await expect(page.locator('#authSetupFields')).toBeHidden();
    await page.click('#btnAuth');await expect(page.locator('#authTitle')).toHaveText('Acesso ao estacionamento');
    expect(await page.locator('#authNome').evaluate(input=>input.required)).toBe(false);
    expect(await page.locator('#authCodigo').evaluate(input=>input.required)).toBe(false);
});

test('tela de acesso recupera indisponibilidade temporária sem reiniciar o navegador',async({page})=>{
    await page.click('#btnAuth');await expect(page.locator('body')).toHaveAttribute('data-session','locked');
    let calls=0;
    await page.route('**/auth/status',route=>{
        if(++calls===1)return route.fulfill({status:503,json:{error:'Banco de dados temporariamente indisponível. Tente novamente em instantes.',code:'DATABASE_UNAVAILABLE'}});
        return route.continue();
    });
    await page.reload();await expect(page.locator('#authMessage')).toContainText('temporariamente indisponível');
    await expect(page.locator('#authRetry')).toBeVisible();await expect(page.locator('#authSubmit')).toBeDisabled();
    await page.click('#authRetry');await expect(page.locator('#authRetry')).toBeHidden();await expect(page.locator('#authSubmit')).toBeEnabled();
    await page.fill('#authLogin','teste');await page.fill('#authSenha','Senha-teste-123');await page.click('#authSubmit');
    await expect(page.locator('body')).toHaveAttribute('data-session','active');
    await expect(page.locator('#connectionStatus')).toHaveText('Sincronizado');
});

test('caixa pela interface: fundo, suprimento, sangria, diferença, aprovação e nova versão',async({page})=>{
    // Encerra a preparação compartilhada dos testes anteriores pelo protocolo normal da API.
    await page.evaluate(async()=>{
        const result=await(await apiFetch(`${BACKEND_BASE}/caixa/turnos/atual`)).json();const id=result.dados?.id;
        if(id){const s=(await(await apiFetch(`${BACKEND_BASE}/caixa/turnos/${id}/resumo`)).json()).dados.resumo;
            await operationRequest('/caixa/turnos/fechar',{operacao_id:crypto.randomUUID(),turno_id:id,revisao:s.revisao,contagem:{dinheiro:s.saldo_esperado,credito:s.total_credito,debito:s.total_debito,pix:s.total_pix}});}
        await CashService.refresh();
    });
    await page.click('#btnTurnoCaixa');await page.fill('#turnoFundoInicial','100');await page.fill('#turnoObservacao','Troco para início de atendimento');await page.click('#confirmarAberturaTurnoBtn');
    await expect(page.locator('#comprovanteCaixaPopup')).toHaveAttribute('aria-hidden','false');await expect(page.locator('#comprovanteCaixa')).toContainText('100,00');
    await page.locator('#comprovanteCaixaPopup [data-close]').click();
    const id=await page.evaluate(async()=> (await(await apiFetch(`${BACKEND_BASE}/caixa/turnos/atual`)).json()).dados.id);
    for(const [type,value]of [['suprimento','20'],['sangria','10']]){
        await page.click('#btnMovimentarCaixa');await page.selectOption('#movimentoTipo',type);await page.fill('#movimentoValor',value);await page.fill('#movimentoMotivo','Movimento autorizado para teste');await page.click('#registrarMovimentoCaixaBtn');
        await expect(page.locator('#comprovanteCaixaPopup')).toHaveAttribute('aria-hidden','false');await expect(page.locator('#comprovanteCaixa')).toContainText(type.toUpperCase());await page.locator('#comprovanteCaixaPopup [data-close]').click();
    }
    await page.click('#btnEntrada');await page.fill('#placaEntrada','MNO2P34');await expect(page.locator('#modeloEntrada')).not.toHaveValue('');await page.click('#registrarBtn');
    await expect(page.locator('#comprovanteEntradaPopup')).toHaveAttribute('aria-hidden','false');await page.locator('#comprovanteEntradaPopup [data-close]').click();
    await page.click('#btnFecharCaixa');await expect(page.locator('#fechamentoResumo')).toContainText('110,00');
    await page.fill('#contagemDinheiro','109');for(const suffix of ['Pix','Credito','Debito'])await page.fill(`#contagem${suffix}`,'0');
    await page.fill('#fechamentoObservacao','Diferença identificada na contagem física');await page.click('#confirmarFechamentoBtn');
    await expect(page.locator('#comprovanteCaixaPopup')).toHaveAttribute('aria-hidden','false');await expect(page.locator('#comprovanteCaixa')).toContainText('Aguardando aprovação');await page.locator('#comprovanteCaixaPopup [data-close]').click();
    await expect(page.locator('#patioCarList')).toContainText('MNO2P34');await expect(page.locator('#cashMessage')).toContainText('aguardam aprovação');
    await page.click('#btnHistoricoFechamentos');await page.locator('[data-cash-action="approve"]').click();await page.fill('#cashDecisionMotivo','Diferença analisada pelo responsável');await page.click('#cashDecisionConfirm');
    await expect(page.locator('#fechamentosHistoricoPopup')).toHaveAttribute('aria-hidden','false');await expect(page.locator('[data-cash-action="approve"]')).toHaveCount(0);
    await page.locator(`[data-cash-action="reopen"][data-id="${id}"]`).click();await page.fill('#cashDecisionMotivo','Recontagem autorizada para corrigir conferência');await page.click('#cashDecisionConfirm');
    await expect(page.locator('#fechamentosHistoricoPopup')).toHaveAttribute('aria-hidden','false');await page.locator('#fechamentosHistoricoPopup [data-close]').click();
    await page.click('#btnFecharCaixa');await page.fill('#contagemDinheiro','110');for(const suffix of ['Pix','Credito','Debito'])await page.fill(`#contagem${suffix}`,'0');await page.click('#confirmarFechamentoBtn');
    await expect(page.locator('#comprovanteCaixaPopup')).toHaveAttribute('aria-hidden','false');await expect(page.locator('#comprovanteCaixa')).toContainText('Conferido sem diferença');
    const versions=await page.evaluate(async id=>(await(await apiFetch(`${BACKEND_BASE}/caixa/turnos/${id}/resumo`)).json()).dados.conferencias,id);
    expect(versions.length).toBe(2);expect(versions[0].versao).toBe(2);expect(versions[1].diferencas.dinheiro).toBe(-1);expect(versions[1].substituida_em).toBeTruthy();
    await page.evaluate(()=>{const open=window.open.bind(window);window.open=(...args)=>{const child=open(...args);if(child)child.print=()=>{child.__printed=true;};return child;};});
    for(const width of ['80','58']){
        await page.selectOption('#printCaixaWidth',width);const pending=page.waitForEvent('popup');await page.locator('[data-receipt-print="comprovanteCaixa"]').click();const popup=await pending;await popup.waitForFunction(()=>window.__printed);
        await expect(popup.locator('body')).toContainText('Dinheiro');await expect(popup.locator('body')).toContainText('110,00');
        const overflow=await popup.evaluate(()=>{const el=document.querySelector('.receipt');return el.scrollWidth>Math.ceil(el.getBoundingClientRect().width);});expect(overflow).toBe(false);
        await popup.evaluate(()=>{window.onafterprint=null;});const pdf=await popup.pdf({path:`../artifacts/fechamento-caixa-${width}mm.pdf`,preferCSSPageSize:true});expect((pdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length).toBe(1);
        await popup.screenshot({path:`../artifacts/fechamento-caixa-${width}mm.png`,fullPage:true});await popup.close();
    }
});

test('período usa expediente sem escolher saída, preserva preço e imprime entrada/saída em 58 e 80 mm',async({page})=>{
    await page.evaluate(()=>{const open=window.open.bind(window);window.open=(...args)=>{const child=open(...args);if(child)child.print=()=>{child.__printed=true;};return child;};});
    const plate='PQR3S45';
    await page.evaluate(async()=>{await operationRequest('/__test/clock',{agora:'2026-11-13T11:00:00Z'});});
    try{
    await page.click('#btnEntrada');await page.fill('#placaEntrada',plate);await expect(page.locator('#modeloEntrada')).not.toHaveValue('');
    await page.check('#diaristaCheck');await expect(page.locator('#diariaRetirada')).toHaveCount(0);await page.click('#registrarBtn');
    await expect(page.locator('#pagamentoPopup')).toHaveAttribute('aria-hidden','false');await expect(page.locator('#resumoPagamento')).toContainText('Período pré-pago');await expect(page.locator('#resumoPagamento')).toContainText('18:00');await expect(page.locator('#resumoPagamento')).toContainText('sem desconto');await expect(page.locator('#splitPagamentoTotal')).toHaveText('R$ 25.00');
    expect(await page.evaluate(async plate=>(await(await apiFetch(`${BACKEND_BASE}/patio/ativos`)).json()).dados.some(row=>row.placa===plate),plate)).toBe(false);
    await page.selectOption('#splitPagamentoLista .split-forma','Dinheiro');await page.fill('#splitPagamentoLista .split-valor','10');await page.click('#addSplitPagamento');
    await page.locator('#splitPagamentoLista .split-forma').nth(1).selectOption('Pix');await page.click('#confirmarPagamentoBtn');
    await expect(page.locator('#comprovanteEntradaPopup')).toHaveAttribute('aria-hidden','false');await expect(page.locator('#comprovanteEntrada')).toContainText('LIMITE DO PERÍODO');await expect(page.locator('#comprovanteEntrada')).toContainText('PERÍODO PAGO');
    await expect(page.locator('#comprovanteEntrada')).toContainText('25,00');await expect(page.locator('#comprovanteEntrada')).not.toContainText('24 h');
    async function print(target,label,width){
        await page.locator(`#${target}`).locator('..').locator('.receipt-width').selectOption(width);
        const pending=page.waitForEvent('popup');await page.locator(`[data-receipt-print="${target}"]`).click();const popup=await pending;await popup.waitForFunction(()=>window.__printed);
        const metrics=await popup.evaluate(()=>{const r=document.querySelector('.receipt');return {overflow:r.scrollWidth>Math.ceil(r.getBoundingClientRect().width),height:r.getBoundingClientRect().height,limitHeight:r.querySelector('[data-period-limit]')?.getBoundingClientRect().height};});
        expect(metrics.overflow).toBe(false);expect(metrics.height*25.4/96).toBeLessThan(150);
        if(metrics.limitHeight)expect(metrics.limitHeight).toBeLessThan(20);
        await expect(popup.locator('body')).toContainText('25,00');await expect(popup.locator('body')).not.toContainText('24 h');
        await popup.evaluate(()=>{window.onafterprint=null;});const pdf=await popup.pdf({path:`../artifacts/diaria-${label}-${width}mm.pdf`,preferCSSPageSize:true});expect((pdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length).toBe(1);
        await popup.screenshot({path:`../artifacts/diaria-${label}-${width}mm.png`,fullPage:true});await popup.close();
    }
    for(const width of ['80','58'])await print('comprovanteEntrada','entrada',width);
    await page.locator('#comprovanteEntradaPopup [data-close]').click();
    await page.reload();await expect(page.locator('#connectionStatus')).toHaveText('Sincronizado');
    await page.evaluate(()=>{const open=window.open.bind(window);window.open=(...args)=>{const child=open(...args);if(child)child.print=()=>{child.__printed=true;};return child;};});
    const card=page.locator('.car-item').filter({hasText:plate});await expect(card).toContainText('Limite do período:');await expect(card).toContainText('R$ 0.00');await expect(card.locator('.btn-cancel-card')).toHaveCount(0);
    await card.locator('.btn-print-card').click();await expect(page.locator('#comprovanteEntrada')).toContainText('PERÍODO PAGO');await page.locator('#comprovanteEntradaPopup [data-close]').click();
    await page.evaluate(async()=>{await operationRequest('/__test/clock',{agora:'2026-11-13T22:01:00Z'});});
        await card.locator('.btn-saida-card').click();await expect(page.locator('#pagamentoPopup')).toHaveAttribute('aria-hidden','false');await expect(page.locator('#resumoPagamento')).toContainText('Período já pago: R$ 25.00');await expect(page.locator('#splitPagamentoTotal')).toHaveText('R$ 7.50');
        await page.selectOption('#splitPagamentoLista .split-forma','Pix');await page.click('#confirmarPagamentoBtn');await expect(page.locator('#comprovantePermanenciaPopup')).toHaveAttribute('aria-hidden','false');
        await expect(page.locator('#comprovantePermanencia')).toContainText('PAGO NA SAÍDA');await expect(page.locator('#comprovantePermanencia')).toContainText('7,50');await expect(page.locator('#comprovantePermanencia')).toContainText('32,50');
        for(const width of ['80','58'])await print('comprovantePermanencia','saida',width);
        await expect(card).toHaveCount(0);
    }finally{await page.evaluate(async()=>{await operationRequest('/__test/clock',{advanceMinutes:0});});}
});

test('configura expediente noturno e recebe período fixo sem desconto na saída antecipada',async({page})=>{
    const original=await page.evaluate(async()=>(await(await apiFetch(`${BACKEND_BASE}/configuracoes`)).json()).dados);
    try{
        await page.click('#btnMenu');await expect(page.locator('label[for="valorDiaria"]')).toHaveText('Valor fixo do período (R$)');
        await page.fill('#expedienteInicio','19:00');await page.fill('#expedienteFim','05:00');
        await page.screenshot({path:'../artifacts/expediente-configuracao.png',fullPage:true});
        page.once('dialog',dialog=>dialog.accept());await page.click('#saveConfigBtn');await expect(page.locator('#menu')).toHaveAttribute('aria-hidden','true');
        await page.reload();await expect(page.locator('#connectionStatus')).toHaveText('Sincronizado');
        await page.click('#btnMenu');await expect(page.locator('#expedienteInicio')).toHaveValue('19:00');await expect(page.locator('#expedienteFim')).toHaveValue('05:00');await page.locator('#menu [data-close]').click();
        await page.evaluate(async()=>{await operationRequest('/__test/clock',{agora:'2026-11-14T04:00:00Z'});});
        await page.click('#btnEntrada');await page.fill('#placaEntrada','ZAB8C90');await page.check('#diaristaCheck');await page.click('#registrarBtn');
        await expect(page.locator('#resumoPagamento')).toContainText('19:00 a 05:00');await expect(page.locator('#resumoPagamento')).toContainText('05:00');await expect(page.locator('#splitPagamentoTotal')).toHaveText('R$ 25.00');
        await page.selectOption('#splitPagamentoLista .split-forma','Pix');await page.click('#confirmarPagamentoBtn');await expect(page.locator('#comprovanteEntrada')).toContainText('PERÍODO PAGO');await expect(page.locator('#comprovanteEntrada')).toContainText('sem desconto');await page.locator('#comprovanteEntradaPopup [data-close]').click();
        await page.locator('.car-item').filter({hasText:'ZAB8C90'}).locator('.btn-saida-card').click();await expect(page.locator('#comprovantePermanenciaPopup')).toHaveAttribute('aria-hidden','false');await expect(page.locator('#comprovantePermanencia')).toContainText('Sem cobrança adicional');await expect(page.locator('#comprovantePermanencia')).toContainText('25,00');
        const total=await page.evaluate(async()=>(await(await apiFetch(`${BACKEND_BASE}/relatorios/financeiro?placa=ZAB8C90`)).json()).resumo.total);expect(Number(total)).toBe(25);
    }finally{
        await page.evaluate(async original=>{await operationRequest('/__test/clock',{advanceMinutes:0});await apiFetch(`${BACKEND_BASE}/configuracoes`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expediente_inicio:original.expediente_inicio.valor,expediente_fim:original.expediente_fim.valor})});},original);
    }
});

test('mensalista pela interface: contrato, parcial, quitação de 30 dias, avisos, relatório e exportação',async({page})=>{
    const plate='STU4V56';
    await page.click('#btnMensalistas');await page.click('#btnNovoMensalista');await page.fill('#mensalistaPlaca',plate);await page.fill('#mensalistaNomeForm','Cliente do plano de 30 dias');await page.fill('#mensalistaPlano','Plano família');await page.fill('#mensalistaValorContrato','275');await page.fill('#mensalistaVeiculos','VWX5Y67');await page.fill('#mensalistaLimite','1');await page.click('#btnSalvarMensalista');
    await page.fill('#mensalistasBusca',plate);await page.click('#btnBuscarMensalistas');await expect(page.locator('#mensalistasLista')).toContainText('Sem pagamento');
    await expect(page.locator('#mensalistasLista [data-pay-id]')).toHaveCount(1);
    await page.locator('#mensalistasLista [data-pay-id]').click();await expect(page.locator('#mensalidadeValor')).toHaveValue('275.00');await page.fill('#mensalidadeReceber','100');await page.selectOption('#splitMensalidadeLista .split-forma','Pix');await page.click('#confirmarMensalidadeBtn');
    await expect(page.locator('#comprovanteMensalidadePopup')).toHaveAttribute('aria-hidden','false');await expect(page.locator('#comprovanteMensalidade')).toContainText('PAGAMENTO PARCIAL');await expect(page.locator('#comprovanteMensalidade')).toContainText('175,00');
    await page.evaluate(()=>{const open=window.open.bind(window);window.open=(...args)=>{const child=open(...args);if(child)child.print=()=>{child.__printed=true;};return child;};});
    for(const width of ['80','58']){
        await page.selectOption('#printMensalidadeWidth',width);const wait=page.waitForEvent('popup');await page.click('[data-receipt-print="comprovanteMensalidade"]');const popup=await wait;await popup.waitForFunction(()=>window.__printed);
        const overflow=await popup.evaluate(()=>{const r=document.querySelector('.receipt');return r.scrollWidth>Math.ceil(r.getBoundingClientRect().width);});expect(overflow).toBe(false);
        await popup.evaluate(()=>{window.onafterprint=null;});const pdf=await popup.pdf({path:`../artifacts/mensalidade-parcial-${width}mm.pdf`,preferCSSPageSize:true});expect((pdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length).toBe(1);await popup.screenshot({path:`../artifacts/mensalidade-parcial-${width}mm.png`,fullPage:true});await popup.close();
    }
    await page.locator('#comprovanteMensalidadePopup [data-close]').click();await page.fill('#mensalistasBusca',plate);await page.click('#btnBuscarMensalistas');await page.locator('#mensalistasLista [data-pay-id]').click();await expect(page.locator('#mensalidadeReceber')).toHaveValue('175.00');await page.selectOption('#splitMensalidadeLista .split-forma','Dinheiro');await page.click('#confirmarMensalidadeBtn');
    await expect(page.locator('#comprovanteMensalidade')).toContainText('30 dias');await expect(page.locator('#comprovanteMensalidade')).toContainText('Pago até');await expect(page.locator('#comprovanteMensalidade')).not.toContainText('PAGAMENTO PARCIAL');await page.locator('#comprovanteMensalidadePopup [data-close]').click();
    await page.locator('#mensalistasLista [data-history-id]').click();await expect(page.locator('#mensalidadeHistoricoConteudo')).toContainText('Recebimentos');await expect(page.locator('#mensalidadeHistoricoConteudo [data-operation-receipt]')).toHaveCount(2);await page.locator('#mensalistasPopup [data-close]').first().click();
    await page.evaluate(async plate=>{await operationRequest('/entrada',{placa:plate,mensalista:true});await syncActiveEntriesFromBackend();updatePatioCarList();},plate);
    for(const [days,label]of [[28,'Vence em até 2 dias'],[30,'Vence hoje'],[31,'Vencido']]){
        await page.evaluate(async days=>{await operationRequest('/__test/clock',{advanceMinutes:days*24*60});await SubscriptionService.alerts();},days);await expect(page.locator('#mensalistasAvisos')).toContainText(label);
    }
    await page.locator('.car-item').filter({hasText:plate}).locator('.btn-saida-card').click();await expect(page.locator('#mensalistaVencidoPopup')).toHaveAttribute('aria-hidden','false');await page.click('#saidaSemRenovar');
    await expect(page.locator('#pagamentoPopup')).toHaveAttribute('aria-hidden','false');expect(await page.locator('#splitPagamentoLista .split-valor').inputValue()).not.toBe('0.00');await page.selectOption('#splitPagamentoLista .split-forma','Pix');await page.click('#confirmarPagamentoBtn');await expect(page.locator('#comprovantePermanencia')).toContainText('Cliente optou por não renovar');await page.locator('#comprovantePermanenciaPopup [data-close]').click();
    await page.evaluate(async()=>{await operationRequest('/__test/clock',{advanceMinutes:0});await SubscriptionService.alerts();});
    await page.click('#btnRelatoriosCaixa');await page.selectOption('#relatorioOrigem','mensalidade');await page.fill('#relatorioPlaca',plate);await page.click('#btnGerarRelatorioCaixa');await expect(page.locator('#relatorioCaixaConteudo')).toContainText('275,00');await expect(page.locator('#relatorioCaixaConteudo')).toContainText('2 / 2');await expect(page.locator('#relatorioCaixaConteudo [data-operation-receipt]')).toHaveCount(2);
    const downloadWait=page.waitForEvent('download');await page.click('#btnExportarFinanceiro');const download=await downloadWait;const exported=await readFile(await download.path(),'utf8');expect(exported).toContain(plate);expect(exported).toContain('275');expect(exported).not.toContain('JKL1M23');
    const printWait=page.waitForEvent('popup');await page.click('#btnImprimirRelatorio');const popup=await printWait;await popup.waitForFunction(()=>window.__printed);await expect(popup.locator('body')).toContainText('275,00');await popup.pdf({path:'../artifacts/relatorio-recebimentos.pdf',preferCSSPageSize:true});await popup.screenshot({path:'../artifacts/relatorio-recebimentos.png',fullPage:true});await popup.close();
    await page.locator('#relatoriosCaixaPopup [data-close]').click();await page.click('#btnHistorico');await page.fill('#filtroAcao','mensalista_contrato_criado');await page.click('#btnVerAuditoria');await expect(page.locator('#historicoConteudo')).toContainText('Operador de teste');await expect(page.locator('#historicoConteudo')).toContainText('mensalista_contrato_criado');
});

test('mensalista vencido renova pela tela de saída e preserva o período já quitado',async({page})=>{
    const plate='XYZ6A78';
    await page.evaluate(async plate=>{
        const row=(await operationRequest('/mensalistas',{placa:plate,nome:'Cliente renova na saída',valor_mensal:300})).dados;
        const q=(await operationRequest(`/mensalistas/${row.id}/cotacao`,{meses:1})).dados;
        const shift=(await(await apiFetch(`${BACKEND_BASE}/caixa/turnos/atual`)).json()).dados.id;
        await operationRequest('/mensalistas/pagamentos',{mensalista_id:row.id,meses:1,revisao:q.revisao,cobranca_id:q.cobranca_id,periodo_previsto:q.fim_periodo,turno_id:shift,operacao_id:crypto.randomUUID(),pagamentos:[{forma_pagamento:'Pix',valor_pago:300}]});
        await operationRequest('/entrada',{placa:plate,mensalista:true});await syncActiveEntriesFromBackend();updatePatioCarList();await operationRequest('/__test/clock',{advanceMinutes:31*24*60});
    },plate);
    try{
        await page.locator('.car-item').filter({hasText:plate}).locator('.btn-saida-card').click();await expect(page.locator('#mensalistaVencidoPopup')).toHaveAttribute('aria-hidden','false');await page.click('#renovarAntesSaida');
        await expect(page.locator('#mensalidadePagamentoPopup')).toHaveAttribute('aria-hidden','false');await expect(page.locator('#mensalidadeReceber')).toHaveValue('300.00');await page.selectOption('#splitMensalidadeLista .split-forma','Dinheiro');await page.click('#confirmarMensalidadeBtn');
        await expect(page.locator('#comprovanteMensalidadePopup')).toHaveAttribute('aria-hidden','false');await expect(page.locator('#continuarSaidaMensalista')).toBeVisible();await page.click('#continuarSaidaMensalista');
        await expect(page.locator('#comprovantePermanenciaPopup')).toHaveAttribute('aria-hidden','false');await expect(page.locator('#comprovantePermanencia')).toContainText('Sem cobrança');await expect(page.locator('.car-item').filter({hasText:plate})).toHaveCount(0);
    }finally{await page.evaluate(async()=>{await operationRequest('/__test/clock',{advanceMinutes:0});});}
});

async function createPaidSubscriber(page,placa,veiculos=[]){
    return page.evaluate(async({placa,veiculos})=>{
        const c=(await operationRequest('/mensalistas',{placa,veiculos,nome:'Mensalista automático '+placa,valor_mensal:300,limite_simultaneo:1})).dados;
        const q=(await operationRequest(`/mensalistas/${c.id}/cotacao`,{})).dados;
        const shift=(await(await apiFetch(`${BACKEND_BASE}/caixa/turnos/atual`)).json()).dados.id;
        await operationRequest('/mensalistas/pagamentos',{mensalista_id:c.id,meses:q.meses,revisao:q.revisao,cobranca_id:q.cobranca_id,periodo_previsto:q.fim_periodo,turno_id:shift,operacao_id:crypto.randomUUID(),pagamentos:[{forma_pagamento:'Pix',valor_pago:300}]});
        return c;
    },{placa,veiculos});
}

test('placa mensalista é reconhecida sem marcar opção, inclusive adicional, e sai sem cobrança',async({page})=>{
    await createPaidSubscriber(page,'LMN2P34',['OPQ3R45']);
    await page.click('#btnEntrada');await page.check('#diaristaCheck');await page.fill('#placaEntrada','lmn-2p34');
    await expect(page.locator('#mensalistaCheck')).toBeChecked();await expect(page.locator('#mensalistaCheck')).toBeDisabled();
    await expect(page.locator('#mensalistaNome')).toHaveValue('Mensalista automático LMN2P34');await expect(page.locator('#mensalistaLookupStatus')).toContainText('Pago até');
    await expect(page.locator('#diaristaCheck')).not.toBeChecked();await expect(page.locator('#diaristaCheck')).toBeDisabled();
    await page.fill('#placaEntrada','OPQ3R45');await expect(page.locator('#mensalistaCheck')).toBeChecked();await page.click('#registrarBtn');
    await expect(page.locator('#comprovanteEntradaPopup')).toHaveAttribute('aria-hidden','false');await expect(page.locator('#comprovanteEntrada')).toContainText('Mensalista');
    await page.locator('#comprovanteEntradaPopup [data-close]').click();const card=page.locator('.car-item').filter({hasText:'OPQ3R45'});await expect(card.locator('.badge')).toContainText('Mensalista');
    await page.evaluate(async()=>{await operationRequest('/__test/prepare',{placa:'OPQ3R45',minutes:65});});
    await card.locator('.btn-saida-card').click();await expect(page.locator('#comprovantePermanenciaPopup')).toHaveAttribute('aria-hidden','false');await expect(page.locator('#comprovantePermanencia')).toContainText('Sem cobrança');
});

test('reconhecimento avisa a vencer, hoje, vencido e suspenso sem liberar benefício indevido',async({page})=>{
    const customer=await createPaidSubscriber(page,'RST4U56');await page.click('#btnEntrada');
    try{
        for(const [days,label,eligible]of [[28,'vence em até 2 dias',true],[30,'vence hoje',true],[31,'mensalidade vencida',false]]){
            await page.evaluate(async days=>{await operationRequest('/__test/clock',{advanceMinutes:days*24*60});},days);
            await page.fill('#placaEntrada','');await page.fill('#placaEntrada','RST4U56');
            await expect(page.locator('#mensalistaLookupStatus')).toContainText(label);await expect(page.locator('#mensalistaCheck')).toBeChecked({checked:eligible});
        }
        await page.evaluate(async id=>{await operationRequest('/__test/clock',{advanceMinutes:0});await apiFetch(`${BACKEND_BASE}/mensalistas/${id}/status`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({estado:'suspenso',motivo:'Suspensão para verificar o reconhecimento automático'})});},customer.id);
        await page.fill('#placaEntrada','');await page.fill('#placaEntrada','RST4U56');await expect(page.locator('#mensalistaLookupStatus')).toContainText('contrato suspenso');await expect(page.locator('#mensalistaCheck')).not.toBeChecked();
        await page.click('#registrarBtn');await expect(page.locator('#comprovanteEntrada')).toContainText('Avulso');
    }finally{await page.evaluate(async()=>{await operationRequest('/__test/clock',{advanceMinutes:0});});}
});

test('resposta mensalista antiga é descartada ao trocar placa ou fechar a entrada',async({page})=>{
    await createPaidSubscriber(page,'UVW5X67');
    let signalStarted,release,signalFinished,started,finished;
    function gate(){started=new Promise(resolve=>{signalStarted=resolve;});finished=new Promise(resolve=>{signalFinished=resolve;});}
    gate();
    await page.route('**/mensalistas/UVW5X67',async route=>{
        const done=signalFinished;const response=await route.fetch();const held=new Promise(resolve=>{release=resolve;});signalStarted();await held;
        try{await route.fulfill({response});}catch{}finally{done();}
    });
    await page.click('#btnEntrada');await page.fill('#placaEntrada','UVW5X67');await started;
    await page.fill('#placaEntrada','YZA6B78');await expect(page.locator('#mensalistaLookupStatus')).toContainText('sem cadastro');release();await finished;
    await expect(page.locator('#mensalistaCheck')).not.toBeChecked();await expect(page.locator('#mensalistaNome')).toHaveValue('');
    gate();await page.fill('#placaEntrada','UVW5X67');await started;await page.locator('#entradaPopup [data-close]').click();release();await finished;
    await expect(page.locator('#mensalistaCheck')).not.toBeChecked();await expect(page.locator('#mensalistaNome')).toHaveValue('');
    await page.unroute('**/mensalistas/UVW5X67');await page.click('#btnEntrada');await expect(page.locator('#mensalistaCheck')).toBeChecked();
    await page.screenshot({path:'../artifacts/mensalista-automatico.png',fullPage:true});
});

test('resposta de pagamento perdida: recarregar e consultar recupera o comprovante sem duplicar',async({page})=>{
    const plate='BCD7E89';await page.click('#btnEntrada');await page.fill('#placaEntrada',plate);await expect(page.locator('#modeloEntrada')).not.toHaveValue('');await page.click('#registrarBtn');await expect(page.locator('#comprovanteEntradaPopup')).toHaveAttribute('aria-hidden','false');await page.locator('#comprovanteEntradaPopup [data-close]').click();
    await page.evaluate(async plate=>{await operationRequest('/__test/prepare',{placa:plate,minutes:65});},plate);
    await page.locator('.car-item').filter({hasText:plate}).locator('.btn-saida-card').click();await expect(page.locator('#pagamentoPopup')).toHaveAttribute('aria-hidden','false');await page.selectOption('#splitPagamentoLista .split-forma','Pix');
    let finished;const lostResponse=new Promise(resolve=>{finished=resolve;});
    await page.route('**/saida',async route=>{await route.fetch();await route.abort('failed');finished();});await page.click('#confirmarPagamentoBtn');await lostResponse;await expect(page.locator('#pendingOperations')).toContainText('Saída');await page.unroute('**/saida');
    await page.reload();await expect(page.locator('#connectionStatus')).toHaveText('Sincronizado');await expect(page.locator('#pendingOperations')).toBeVisible();await page.locator('[data-pending-check]').click();
    await expect(page.locator('#comprovantePermanenciaPopup')).toHaveAttribute('aria-hidden','false');await expect(page.locator('#comprovantePermanencia')).toContainText('7,50');await expect(page.locator('#pendingOperations')).toBeHidden();
    const summary=await page.evaluate(async plate=>(await(await apiFetch(`${BACKEND_BASE}/relatorios/financeiro?placa=${plate}`)).json()).resumo,plate);expect(summary.recebimentos).toBe(1);expect(Number(summary.total)).toBe(7.5);
});

test('painel de operação verifica backup, restaura com ponto de retorno e libera após conferência',async({page})=>{
    const backup=await page.evaluate(async()=>(await(await apiFetch(`${BACKEND_BASE}/backup`)).json()).dados);
    await page.evaluate(async()=>{await operationRequest('/entrada',{placa:'EFG8H90'});await syncActiveEntriesFromBackend();updatePatioCarList();});
    await page.click('#btnMenu');await page.click('#btnOperacao');await expect(page.locator('#operacaoResumo')).toContainText('Banco disponível');await page.click('#operacaoBackup');await expect(page.locator('#operacaoBackups')).toContainText('concluido');
    const downloaded=page.waitForEvent('download');await page.locator('[data-backup-download]').first().click();const file=await downloaded;const content=await readFile(await file.path(),'utf8');expect(content).toContain('AES-256-GCM');expect(content).not.toContain('scrypt:');
    await page.locator('#operacaoPopup [data-close]').click();await page.click('#btnMenu');await page.locator('#backupFileInput').setInputFiles({name:'backup-teste.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
    await expect(page.locator('#restorePopup')).toHaveAttribute('aria-hidden','false');await expect(page.locator('#restoreResumo')).toContainText('validado pelo servidor');await page.fill('#restoreMotivo','Recuperação de teste com conferência operacional');await page.fill('#restoreConfirmacao','RESTAURAR');await page.fill('#restoreSenha','Senha-teste-123');await page.click('#restoreSubmit');
    await expect(page.locator('#operacaoPopup')).toHaveAttribute('aria-hidden','false');await expect(page.locator('#operationBanner')).toContainText('manutenção');await expect(page.locator('#operacaoRetornos [data-return-download]')).toHaveCount(1);await expect(page.locator('#btnEntrada')).toBeDisabled();
    const result=await page.evaluate(async()=>{const res=await apiFetch(`${BACKEND_BASE}/entrada`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({placa:'HIJ9K01'})});return res.status;});expect(result).toBe(503);
    const safetyWait=page.waitForEvent('download');await page.locator('[data-return-download]').click();const safety=await safetyWait;expect(await readFile(await safety.path(),'utf8')).toContain('EFG8H90');
    await page.fill('#operacaoMotivo','Pátio e recebimentos conferidos após recuperação');await page.click('#operacaoLiberar');await expect(page.locator('#operationBanner')).toBeHidden();await expect(page.locator('#btnEntrada')).toBeEnabled();
    await page.locator('#operacaoPopup [data-close]').click();await page.keyboard.press('F2');await expect(page.locator('#entradaPopup')).toHaveAttribute('aria-hidden','false');
});

test('backup manual baixa arquivo completo cifrado sem armazenamento externo',async({page})=>{
    await page.evaluate(async()=>{await operationRequest('/__test/backup-mode',{externo:false});});
    try{
        await page.click('#btnMenu');await page.click('#btnOperacao');
        await expect(page.locator('#operacaoResumo')).toContainText('Modo de backup: manual');
        await expect(page.locator('#operacaoResumo')).not.toContainText('Armazenamento privado: pendente');
        await expect(page.locator('#operacaoBackupExterno')).toBeHidden();
        const plainWait=page.waitForEvent('download');await page.click('#operacaoBackupOperacional');
        const plain=await plainWait;const data=JSON.parse(await readFile(await plain.path(),'utf8'));
        expect(data.versao).toBe(3);expect(data.tabelas.usuarios).toBeUndefined();
        const cipherWait=page.waitForEvent('download');await page.click('#operacaoBackupManual');
        const cipher=await cipherWait;const bytes=await readFile(await cipher.path(),'utf8');
        expect(bytes).toContain('AES-256-GCM');expect(bytes).not.toContain('scrypt:');
        await expect(page.locator('#operacaoResumo')).not.toContainText('Ainda não registrado');
        await page.screenshot({path:'../artifacts/backup-manual.png',fullPage:true});
    }finally{await page.evaluate(async()=>{await operationRequest('/__test/backup-mode',{externo:true});});}
});

test('recuperação administrativa pela interface consome o código de uso único',async({page})=>{
    await page.evaluate(async()=>{await operationRequest('/auth/users',{login:'recuperavel',nome:'Administrador recuperável',perfil:'administrador',senha:'Senha-anterior-123'});});
    await page.click('#btnAuth');await page.click('#btnRecuperarAcesso');await page.fill('#recoveryLogin','recuperavel');await page.fill('#recoveryCodigo','preview-recovery-'.repeat(4));await page.fill('#recoverySenha','Nova-senha-recuperada-123');await page.click('#recoverySubmit');
    await expect(page.locator('#authMessage')).toContainText('código de recuperação');
    await page.fill('#authLogin','recuperavel');await page.fill('#authSenha','Nova-senha-recuperada-123');await page.click('#authSubmit');await expect(page.locator('#sessionIdentity')).toContainText('Administrador recuperável');
    const status=await page.evaluate(async()=>(await(await apiFetch(`${BACKEND_BASE}/auth/status`)).json()).recuperacao_disponivel);expect(status).toBe(false);
});
