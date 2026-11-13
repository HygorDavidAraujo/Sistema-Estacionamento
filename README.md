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

O schema é preparado no primeiro acesso à API que precisa do banco, sem exclusão dos dados existentes. A versão aplicada é registrada em `estacionamento_migracoes`; novas instâncias consultam essa versão, sem repetir todos os comandos de schema. Falhas transitórias permitem nova tentativa, sem reiniciar o servidor. A tabela `veiculos_cache` armazena consultas mesmo quando nenhuma entrada é registrada.

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

O botão **Acesso** usa usuário e senha individual. Nenhuma operação é liberada sem sessão, inclusive no ambiente local. Senhas são armazenadas com scrypt; sessões expiram após 8 horas e são revogadas ao sair, alterar senha, desativar usuário ou modificar seu perfil. Alterações exigem o token CSRF da sessão. O antigo cabeçalho `x-admin-token` não autoriza operações.

No primeiro uso local, inicie `npm start` e use o código de primeiro acesso exibido no terminal para criar o administrador. Não há usuário ou senha padrão. Na hospedagem, configure `AUTH_SETUP_TOKEN` como um segredo exclusivo antes da primeira implantação. Um `ADMIN_TOKEN` antigo pode servir somente como código inicial durante a transição; não funciona como login compartilhado. Depois de existir um usuário, o cadastro inicial fica bloqueado. Os usuários seguintes são criados em **Configurações → Usuários e permissões**.

Perfis: operador registra entradas, saídas e recebimentos; supervisor também administra mensalistas, cancela entradas com justificativa e gerencia fechamento; financeiro consulta valores e recebe mensalidades; administrador também altera tarifas, usuários e backups. O caixa permite um turno aberto por vez, com responsável individual, fundo inicial, sangrias, suprimentos e conferência por meio de pagamento. Recebimentos e saídas exigem o turno aberto do próprio usuário. O funcionamento e a ativação do passo 2 estão em [PASSO_2_IMPLEMENTACAO.md](PASSO_2_IMPLEMENTACAO.md).

Para Vercel, mantenha as variáveis do banco, o código inicial de configuração e as opções de consulta no ambiente do projeto. A API está disponível em `/api`. Sessões em produção exigem HTTPS. Origens adicionais, quando necessárias, devem ser explicitadas em `ALLOWED_ORIGINS`, separadas por vírgula. Alterações locais precisam ser publicadas para aparecer na versão hospedada.

O fluxo de ativação por **GitHub → Vercel**, incluindo as variáveis de Production e o primeiro administrador, está em [PASSO_1_IMPLEMENTACAO.md](PASSO_1_IMPLEMENTACAO.md). O `vercel.json` inclui explicitamente o schema e as migrações SQL no pacote do backend.

O prazo padrão de conexão e de consulta é 15 segundos. Ajustes opcionais usam `PG_CONNECTION_TIMEOUT_MS` e `PG_QUERY_TIMEOUT_MS` (milissegundos). No Vercel, o pool é integrado ao ciclo de suspensão das funções com `attachDatabasePool`. Se houver falha transitória ao abrir a tela de acesso, use **Tentar novamente**. O diagnóstico da correção está em [CORRECAO_503_VERCEL.md](CORRECAO_503_VERCEL.md).

O limite por IP das rotas de consulta/reconhecimento é local à instância do servidor; não constitui uma cota global entre instâncias serverless.

## Verificação

```powershell
cd backend
npm test
npm run test:browser
npm audit
```

Os testes de segurança e os testes de navegador usam a aplicação real com PostgreSQL isolado em memória por PGlite, sem conexão ao banco operacional. Validam permissões, CSRF, cobrança, rollback, idempotência, backup e recibos, além de vídeo sintético e Tesseract real. Os testes dos fornecedores usam respostas simuladas. O navegador configurado é Microsoft Edge; ajuste `channel` em `playwright.config.js` se usar outro Chromium instalado.

## Cobranças e impressão

Novas entradas guardam a tarifa vigente e seu comprovante original. A saída recebe uma cotação do servidor válida por 2 minutos; o servidor valida o pagamento integral e grava baixa, parcelas e auditoria na mesma transação. Repetir a mesma confirmação não duplica recebimentos. A diária é paga antecipadamente na entrada e vale até a data e o horário de retirada definidos pelo operador, conforme o fechamento do estacionamento. As cerca de dez horas são uma referência operacional, sem duração fixa no cálculo. Após o limite combinado, cobra-se apenas o atraso pela tarifa avulsa, por hora iniciada, sem uma nova tolerância inicial. A diária não é cobrada novamente na saída. Para mensalista, entrada gratuita exige cadastro ativo com vencimento válido; mensalidades são recebidas pelo valor da tabela do servidor, sem desconto livre no navegador.

Selecionar **Diária** na entrada exige informar **Retirar até** e confirmar o pagamento no próprio turno aberto. Entrada, recebimento e comprovante são gravados na mesma transação. O ticket reúne entrada, pagamento e horário limite nos modelos de 80 mm e 58 mm. A regra de atraso, o tratamento dos registros antigos e a publicação estão em [CORRECAO_DIARIA_ANTECIPADA.md](CORRECAO_DIARIA_ANTECIPADA.md).

Entrada, saída e mensalidade possuem impressão em **80 mm e 58 mm**, com seleção no próprio comprovante. O layout usa margens pequenas, linhas compactas e altura calculada conforme o conteúdo, preservando identificação, valores, horários, pagamento e QR de entrada. A preferência de largura fica neste navegador. Configure a impressora na mesma largura e desative cabeçalhos/rodapés do navegador; o avanço/corte físico depende do driver e da impressora.

Abertura, sangria, suprimento e fechamento do caixa também possuem comprovantes compactos nos dois formatos. O fechamento compara valores esperados e conferidos; diferenças exigem justificativa e aprovação de supervisor ou administrador. Reabrir um turno exige justificativa, preserva a conferência anterior e gera uma nova versão ao fechar. O pátio permanece ativo durante a troca de turno.

O backup operacional atual usa a versão 2 e inclui turnos, movimentos, ajustes e conferências. A versão 1 também pode ser restaurada: seus turnos tornam-se legados, sem atribuição financeira retroativa. A restauração exige administrador, sua senha e a confirmação `RESTAURAR`, valida todas as tabelas antes de substituir registros e realinha sequências. Usuários, senhas, sessões e cotações temporárias não fazem parte do arquivo. Credenciais de acesso precisam de procedimento de recuperação separado. Arquivos antigos sem versão não são aceitos para restauração automática. Limite de requisição: 10 MB, sujeito também aos limites da hospedagem. Backup automático e contingência continuam previstos no passo 4.

O relatório inicial está em `ANALISE_TECNICA.md`; ele descreve o estado anterior às correções desta implementação.

## Estrutura

- `backend/routes/plates.js`: rotas, upload e diagnóstico de serviços.
- `backend/services/vehicle-lookup.js`: fornecedores, cache, cota e deduplicação.
- `backend/services/vehicle-repository.js`: persistência do cadastro consultado.
- `frontend/js/plate-camera.js`: sessão da câmera, enquadramento e confirmação.
- `frontend/js/ocr.service.js`: OCR local e ciclo de vida do worker.
- `frontend/js/plate.service.js`: comunicação com a API e escolha da leitura.
- `backend/test/`: testes de lógica, HTTP e navegador.
