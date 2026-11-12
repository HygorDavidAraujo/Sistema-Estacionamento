# Sistema de estacionamento

Central de operação em português com controle de entrada/saída, pátio, mensalistas, caixa, consulta cadastral por placa e reconhecimento pela câmera ou foto.

## Executar

Requisitos: Node.js 22 ou superior, npm e PostgreSQL (local ou Neon).

1. Configure `backend/.env` a partir de `backend/.env.example` caso o arquivo ainda não exista. Preserve os valores de um `.env` existente.
2. Defina `DATABASE_URL` e, para conexão SSL do Neon, `PGSSLMODE=require`.
3. Instale e inicie:

```powershell
cd backend
npm install
npm start
```

Abra **http://localhost:3000**. O mesmo servidor atende frontend e API. Se a porta estiver ocupada, observe a próxima porta informada no terminal. Também é possível iniciar da raiz com `node backend/server.js`; a configuração do backend será carregada da mesma forma.

O schema é aplicado na inicialização sem exclusão dos dados existentes. A nova tabela `veiculos_cache` armazena consultas mesmo quando nenhuma entrada é registrada.

## Consulta gratuita: marca, modelo e cor

O fornecedor padrão é **FIPE API/Parallelum, endpoint de placas Alpha**. Ele documenta os campos `brand`, `model` e `color`. A integração faz a normalização para `marca`, `modelo` e `cor`.

```dotenv
VEHICLE_LOOKUP_PROVIDER=parallelum
VEHICLE_CACHE_DAYS=30
# FIPE_SUBSCRIPTION_TOKEN=seu_token_gratuito_opcional
```

Limites documentados em 12/11/2026: **5 consultas mensais sem token; 10 consultas bem-sucedidas mensais com token gratuito**. O endpoint está em Alpha, pode mudar e não garante disponibilidade ou cobertura de todas as placas. A documentação não esclarece o agrupamento da cota anônima entre clientes; em hospedagens compartilhadas, não presuma uma cota exclusiva por estacionamento.

O cache do servidor é consultado primeiro, e consultas simultâneas da mesma placa compartilham a chamada externa. Não há migração automática para serviço pago. Quando a cota acaba, o cadastro já salvo continua disponível e a interface permite atendimento manual, inclusive com marca/modelo ainda desconhecidos.

Fonte: [documentação do endpoint de placas](https://fipe.api.br/docs/api/busca-por-placa-alpha).

Alternativas opcionais, selecionadas explicitamente no servidor:

- `VEHICLE_LOOKUP_PROVIDER=simplesapi` com `SIMPLES_API_KEY`.
- `VEHICLE_LOOKUP_PROVIDER=apiplacas` com `API_PLACAS_TOKEN`.

Esses serviços têm regras próprias de cobrança. Configure somente se desejar utilizá-los. Os tokens nunca são enviados ao navegador. Cada serviço possui adaptador próprio; não basta trocar a URL.

## Câmera e envio de foto

1. Abra **Registrar entrada → Ler com a câmera**.
2. Permita o acesso e alinhe a placa dentro da moldura.
3. Escolha outra câmera, ajuste o zoom ou ligue a lanterna se o dispositivo oferecer esses recursos.
4. Para motos, marque **Placa de moto (duas linhas)**.
5. A leitura automática faz até três tentativas sequenciais. Você também pode usar **Capturar placa** ou **Enviar foto**.
6. Confira o recorte e os sete caracteres; use **Usar esta placa** para preencher o formulário e consultar os dados cadastrais.

O OCR usa **Tesseract.js 5.1.1 no próprio navegador**, inclusive no celular, sem cobrança por leitura. A primeira execução baixa biblioteca/modelo pela internet. Precisão depende de enquadramento, nitidez e iluminação; uma leitura sintética de teste não representa a taxa de acerto no estacionamento.

Na câmera, são comparados três quadros localmente e o recorte parte dos pixels originais do vídeo. Não há envio contínuo de quadros ao servidor. Fechar a câmera, fechar o formulário ou ocultar a página cancela a operação e impede a aplicação de resultados antigos.

Opcionalmente, configure **Plate Recognizer Snapshot** no servidor:

```dotenv
ANPR_API_KEY=sua_chave
# URL padrão já é usada quando existe uma chave.
ANPR_URL=https://api.platerecognizer.com/v1/plate-reader/
```

Com a nuvem configurada, uma captura pode enviar **uma imagem** ao fornecedor se o OCR local não encontrar placa. Confirme o plano e a cota da conta. O adaptador espera o contrato do Plate Recognizer; outros fornecedores não são compatíveis apenas mudando a URL. Placas simuladas e `hint` foram removidos do fluxo real.

A câmera exige **HTTPS ou localhost**. Para abrir pelo celular, use a versão HTTPS; um endereço HTTP da rede local pode bloquear `getUserMedia`. Enviar foto continua sendo uma alternativa de captura.

## Acesso e hospedagem

Defina um `ADMIN_TOKEN` longo e exclusivo no ambiente de produção e informe-o pelo botão **Acesso**. Consultas de placa e leitura de dados operacionais exigem o token quando configurado. Em Vercel ou `NODE_ENV=production`, operações protegidas ficam indisponíveis se o token não tiver sido configurado.

Para Vercel, mantenha as variáveis do banco, o `ADMIN_TOKEN` e as opções de consulta no ambiente do projeto. A API está disponível em `/api`. Alterações locais precisam ser publicadas para aparecer na versão hospedada.

O limite por IP das rotas de consulta/reconhecimento é local à instância do servidor; não constitui uma cota global entre instâncias serverless.

## Verificação

```powershell
cd backend
npm test
npm run test:browser
npm audit
```

Os testes unitários e HTTP usam dados simulados e não acessam o banco real nem fornecedores. Os testes de navegador usam um servidor isolado, vídeo sintético e uma imagem de placa gerada para testar o Tesseract real. O navegador configurado é Microsoft Edge; ajuste `channel` em `playwright.config.js` se usar outro Chromium instalado.

O relatório inicial está em `ANALISE_TECNICA.md`; ele descreve o estado anterior às correções desta implementação.

## Estrutura

- `backend/routes/plates.js`: rotas, upload e diagnóstico de serviços.
- `backend/services/vehicle-lookup.js`: fornecedores, cache, cota e deduplicação.
- `backend/services/vehicle-repository.js`: persistência do cadastro consultado.
- `frontend/js/plate-camera.js`: sessão da câmera, enquadramento e confirmação.
- `frontend/js/ocr.service.js`: OCR local e ciclo de vida do worker.
- `frontend/js/plate.service.js`: comunicação com a API e escolha da leitura.
- `backend/test/`: testes de lógica, HTTP e navegador.
