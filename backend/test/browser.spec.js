import { test, expect } from '@playwright/test';

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
    await page.route('**/mensalistas/99/pagamentos?limit=100',route=>route.fulfill({json:{success:true,dados:[{id:1,valor_pago:300,observacao:'<img src=x onerror="window.__xss=1">',forma_pagamento:'<b>Pix</b>'}]}}));
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
