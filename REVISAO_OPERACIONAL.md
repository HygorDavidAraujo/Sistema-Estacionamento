# Revisão operacional do sistema de estacionamento

Data: 12/11/2026. Escopo: código local, interface, API, schema, acesso, entrada/saída, turnos, caixa, mensalistas, histórico, relatórios, backup e testes.

Atualização em 13/11/2026: este documento preserva o diagnóstico anterior às correções. A implementação do primeiro passo está em `PASSO_1_IMPLEMENTACAO.md`. As referências de linhas e os scripts de reprodução abaixo correspondem à versão revisada originalmente; para validar o código atual, use os testes descritos no documento da implementação.

## Parecer

O projeto tem uma base útil de operação: pátio compartilhado pelo servidor, histórico persistente, pagamentos divididos, mensalistas, consulta de placas, QR Code e câmera. Ainda há falhas que comprometem a confiabilidade financeira, a autorização das operações e a recuperação dos dados. Minha recomendação é corrigir esses pontos antes de depender dele como controle definitivo de uma operação com vários funcionários.

O fluxo avaliado foi: operador acessa a central → abre turno → registra entrada → calcula e recebe a permanência ou mensalidade → libera a saída → confere e fecha o caixa → consulta e recupera os registros.

Esta revisão não alterou as regras do aplicativo nem os dados do banco. Não houve publicação, restauração real ou comando sobre equipamentos físicos.

## Evidências e limites

| Verificação | Resultado | Alcance |
|---|---|---|
| `npm test`, em `backend/` | 21 testes passaram | Lógica, HTTP, autenticação de rotas e integração de placas com dependências simuladas |
| `npm run test:browser`, em `backend/` | 7 testes passaram | Edge, consulta, câmera, cancelamento de leitura, OCR e formulário móvel em servidor de teste |
| `npm audit --json`, em `backend/` | 0 vulnerabilidades reportadas | Dependências abrangidas pelo npm; não detecta falhas nas regras de negócio |
| `node artifacts/auditoria-operacional.cjs` | 16 comportamentos reproduzidos | Handlers e funções reais com banco/DOM simulados; sem conexão ao banco |
| `node artifacts/auditoria-xss.cjs` | Execução de JavaScript confirmada no Edge | Renderização real do histórico de mensalidades em página isolada |
| Presença de configuração local, sem exibir valores | Banco configurado; token administrativo ausente; SSL exigido; fuso não explicitado | O código usa `America/Sao_Paulo` como fuso padrão |

Os scripts de reprodução estão em `artifacts/`, diretório ignorado pelo Git. São provas do comportamento encontrado, não testes de regressão que atestam segurança. Alguns deles esperam justamente a aceitação de uma operação incorreta.

Não foram validados com PostgreSQL real: concorrência entre terminais, recuperação de backup, bloqueios, falhas durante commit e integridade dos registros existentes. A condição de corrida na abertura de turnos foi reproduzida com interleaving simulado e confrontada com a ausência de restrição no schema. Não houve teste de carga, consulta de dados pessoais reais, verificação da hospedagem ou acionamento de cancela/impressora física.

## Prioridades

- **P0 — imediato:** falhas com possibilidade de cobrança incorreta, perda de dados, execução de código na interface ou privilégios administrativos indevidos.
- **P1 — antes de operação profissional:** integridade de turno, fechamento, mensalidades, concorrência, auditoria e relatórios.
- **P2 — evolução:** produtividade, gestão, comprovantes e integrações.

## Acesso ao sistema e autorização

### A01 — P0: acesso compartilhado e configuração local sem autenticação

**Evidência:** `backend/server.js:47–61`; `frontend/script.js:5–13` e `717–729`; ausência de tabela de usuários em `backend/schema.sql`. Na configuração carregada nesta revisão, `ADMIN_TOKEN` não está definido.

Fora de produção/Vercel, a falta desse token faz `requireAuth` autorizar a requisição. O servidor também inicia sem restringir explicitamente a interface de rede. Se estiver acessível por outros computadores, a configuração local permite operações sem credencial. Em produção/Vercel, o código bloqueia as operações protegidas com 503 quando o token está ausente; esse comportamento é positivo.

Quando configurado, existe um único segredo com poderes compartilhados. Quem registra entrada pode também alterar tarifas, forçar fechamento e restaurar backup. Não há identidade individual, expiração de sessão ou revogação por funcionário.

**Melhoria:** usuários individuais; perfis de operador, supervisor, financeiro e administrador; sessões revogáveis com expiração; permissões verificadas no servidor em cada operação. Operador não deve restaurar banco, sobrescrever fechamento nem conceder descontos livremente. Fora de um modo de demonstração explícito, a configuração sem autenticação deve impedir operações.

### A02 — P1: o botão Acesso confirma sem validar; Sair conserva dados

**Reproduzido:** qualquer texto informado é salvo e anunciado como acesso aplicado. A API continua recusando um token incorreto, mas a interface comunica sucesso sem autenticação efetiva. Ao sair, apenas `adminToken` é removido; dados do pátio, documentos e conteúdo já renderizado permanecem.

**Melhoria:** validar a sessão antes de anunciar sucesso; tratar 401 de forma central; limpar dados operacionais, formulários e modais ao sair; suspender consultas enquanto não houver sessão. Preferir sessão em cookie `HttpOnly`, `Secure` e política `SameSite` apropriada, com proteção das operações conforme o mecanismo adotado.

### A03 — P0: observações podem executar JavaScript na interface

**Evidência:** `frontend/script.js:1543–1573`, `1583–1608`, `1991–2011` e `2174–2304`. Há interpolações de observação, nome e forma de pagamento em `innerHTML` sem escape consistente. O servidor aceita esses textos.

**Reproduzido no Edge:** uma observação com elemento de imagem e evento `onerror` executou um marcador JavaScript ao renderizar o histórico da mensalidade. A prova usou apenas uma página isolada. A persistência desse campo é aceita pelo handler e foi verificada no código; não foi necessário gravar o conteúdo no banco real.

**Impacto:** conteúdo inserido por um usuário ou importado de um backup pode executar código na sessão de quem consulta os dados. O token em `localStorage` fica acessível a scripts da página.

**Melhoria:** renderizar textos com `textContent`; aplicar escape em todas as interpolações; restringir formas de pagamento a códigos conhecidos; revisar os demais renderizadores. Acrescentar política de segurança de conteúdo como defesa complementar.

## Entrada, permanência e liberação da saída

### O01 — P0: o servidor aceita o preço enviado pelo navegador

**Evidência:** `frontend/script.js:127–163`, `1051–1088` e `1137–1164`; `backend/server.js:268–390`.

A tarifa usa relógio e valores locais do navegador. `/saida` recebe `valor_pago` e `tempo_permanencia` sem recalcular a cobrança. Foi reproduzida saída sem valor, registrada por zero, e saída com valor negativo de R$ 25. As provas invocam o handler como um operador autorizado; não representam um bypass de autenticação.

**Melhoria:** calcular valor, período e tolerância no servidor, com horários oficiais e tarifa versionada; validar números finitos, escala monetária e limites. Só permitir gratuidade, desconto ou ajuste mediante regra explícita e autorização registrada. Usar centavos inteiros ou aritmética decimal no cálculo.

### O02 — P0: marcar Mensalista concede isenção sem validar contrato

**Evidência:** `backend/server.js:177–266`; `frontend/script.js:320–346` e `152–160`.

O servidor aceita o indicador `mensalista` da requisição, grava a entrada e cria/atualiza o cadastro sem consultar se há contrato ativo e quitado. A saída no navegador custa zero para esse indicador. O alerta de vencimento da interface não bloqueia a operação, e o campo `ativo` também não é exigido na autorização da entrada.

**Melhoria:** resolver o benefício a partir do cadastro/contrato no servidor. Distinguir ativo, em dia, vencido, suspenso e cancelado. Definir tolerância e tratamento de vencidos; liberação excepcional deve exigir supervisor e justificativa. Cadastro novo não deve equivaler automaticamente a mensalidade paga.

### O03 — P1: duplicidade de placa e lotação não são protegidas contra concorrência

**Evidência:** `backend/server.js:214–248`; `backend/schema.sql:3–31`; `frontend/script.js:975–997`.

A API verifica quantidade ocupada e insere em consultas separadas. Não existe índice único parcial para placa ativa. A prevenção de duplicidade está principalmente no cache do navegador. Dois terminais podem aceitar a última vaga ou a mesma placa ao mesmo tempo.

A saída por placa usa um `UPDATE` que pode atingir todas as entradas ativas dessa placa, mas trata apenas o primeiro `id` retornado para o caixa. O fallback por placa após falha de `entryId` também pode operar em outra permanência se o cliente estiver desatualizado.

**Melhoria:** unicidade de placa ativa no banco, controle transacional da capacidade e saída vinculada a uma única permanência identificada pelo servidor. Tratar conflitos com 409 e resposta clara.

### O04 — P1: cancelamento permite retirar veículo sem cobrança e sem motivo obrigatório

**Evidência:** `backend/server.js:474–506`; `frontend/script.js:643–652` e `1227–1272`; `index.html:382–397`.

A API aceita motivo vazio e usa a mesma credencial de qualquer operador. A interface usa um prompt opcional, embora exista um modal que menciona mínimo de dez caracteres e cujos botões não têm tratamento no script. O `UPDATE` final do cancelamento filtra apenas por `id`, sem exigir novamente `status = 'ativo'`: uma saída concorrente pode ser sobrescrita como cancelamento, conservando lançamentos financeiros incompatíveis.

**Melhoria:** autorização específica, motivo obrigatório no servidor, transição de estado atômica e identificação do responsável. Separar cancelamento de entrada equivocada, isenção de cobrança e estorno de pagamento.

### O05 — P1: cache legado pode trazer veículo já removido de volta

**Reproduzido:** `frontend/js/storage.service.js:64–109`.

`replaceEntries([])` esvazia a lista sincronizada, mas mantém o espelho por placa. Uma busca posterior por placa usa esse espelho e recria uma entrada local, mesmo depois de o servidor ter informado pátio vazio. O fenômeno é especialmente relevante quando outro terminal registra a saída.

**Melhoria:** retirar o fallback legado após a migração e eliminar chaves antigas durante a reconciliação. Confirmar no servidor a permanência antes de preparar cobrança e tratar conexão indisponível separadamente de veículo não encontrado.

### O06 — P1: regras de diária, tolerância e alteração de preço precisam de contrato claro

**Reproduzido:** uma permanência marcada como diária continua custando uma única diária após 72 horas (`frontend/script.js:152–163`). Pode ser uma política intencional, mas precisa estar definida explicitamente; hoje não há recorrência por 24 horas ou diária de calendário.

As tarifas ficam no cache e não são congeladas por permanência. Um terminal antigo pode cobrar outro preço; mudar a tarifa pode afetar veículos já no pátio. Se o primeiro carregamento das configurações falhar, os valores padrão da primeira hora/adicional/tolerância são colocados no formulário, mas não são todos gravados no cache utilizado pelo cálculo (`frontend/script.js:801–867`), permitindo total zero sem configuração local prévia. O preço também fica congelado ao abrir a tela de pagamento, ainda que o operador demore a confirmar.

**Melhoria:** regras explícitas para fração, tolerância inicial/adicional, pernoite, diária, teto e ticket perdido; tarifa versionada; cotação do servidor com validade e indicação clara do que foi cobrado.

Não há integração de acionamento e confirmação de cancela física no código revisado. Se “liberação de acesso” também se refere à cancela, esse fluxo ainda exige implementação e teste específico de dispositivo: comando, confirmação, repetição segura e exceção manual auditada.

## Turnos, caixa e fechamento

### C01 — P0: saída e pagamentos não formam uma transação única

**Evidência:** `backend/server.js:306–352`.

**Reproduzido:** o histórico é baixado, o primeiro pagamento dividido é inserido e o segundo falha; a API devolve 500 sem desfazer as alterações anteriores. O veículo já saiu no banco. Uma repetição encontra a entrada encerrada.

O resumo diário deixa de considerar o valor do histórico assim que existe qualquer movimento de saída para aquela permanência (`backend/server.js:123–149`). Nesse cenário, o caixa pode contar apenas a parcela gravada.

**Melhoria:** envolver seleção/bloqueio da permanência, cobrança, baixa, todos os pagamentos e auditoria na mesma transação. Acrescentar identificador idempotente para repetir a requisição com segurança após queda de rede.

### C02 — P1: turno aberto não governa a operação financeira

**Evidência:** rotas de turno em `backend/server.js:819–956`; tabelas de movimento/turno em `backend/schema.sql:72–95` e `122–134`.

O turno guarda datas e observações. Os movimentos não têm `turno_id`, operador ou terminal. É possível receber e liberar saídas sem turno, inclusive depois de fechar o turno. Fechar turno não fecha caixa; fechar caixa não encerra turno. O painel soma o dia civil inteiro, sem distinguir os responsáveis.

**Melhoria:** caixa/terminal e turno com responsável, fundo inicial, estados e permissões. Cada recebimento deve pertencer a um turno aberto. Preservar a permanência do veículo entre turnos e atribuir o recebimento ao turno que realmente o recebeu, inclusive ao atravessar a meia-noite.

### C03 — P1: dois turnos podem ser abertos simultaneamente

**Reproduzido com consultas simuladas concorrentes:** `backend/server.js:842–860`; não há restrição de unicidade de turno aberto no schema.

As duas requisições podem ler “nenhum aberto” antes dos dois inserts. O fechamento também lê e atualiza em etapas separadas, sem condição final `fechado_em IS NULL`.

**Melhoria:** restrição única parcial por caixa/terminal para turno aberto e transições atômicas. O banco deve garantir a regra mesmo se dois operadores clicarem juntos.

### C04 — P1: fechamento é uma fotografia do dia, sem conferência física

**Evidência:** `backend/server.js:734–777`; `frontend/script.js:1899–1958`.

Não existem saldo inicial, dinheiro contado, diferença, sangria, suprimento, retirada, despesas ou conferência de cartões/Pix. Depois de salvar o fechamento, novas entradas financeiras continuam alterando o mesmo dia, sem atualizar o resumo salvo. O fechamento não captura um conjunto imutável de movimentos nem delimita a operação.

**Melhoria:** fechamento por turno com saldo esperado, contagem, diferença, justificativa e aprovação quando necessário. Registrar separadamente totais por meio de pagamento e dinheiro efetivamente na gaveta. Guardar o conjunto/limite de movimentos e impedir inclusão retroativa silenciosa.

Fórmula sugerida: `dinheiro esperado = fundo inicial + recebimentos em dinheiro + suprimentos − sangrias − devoluções em dinheiro − saídas autorizadas`. Pix e cartões devem ter conferência própria, sem compor a gaveta física.

### C05 — P1: fechamento forçado sobrescreve o anterior

**Reproduzido:** `{ force: true }` permite sobrescrever o resumo sem justificativa no servidor. A interface exige observação, mas isso não protege a API (`backend/server.js:734–770`; `frontend/script.js:1923–1937`).

Todos os usuários do token têm a mesma permissão. A linha original é atualizada e não há histórico estruturado de versões. Há evento de auditoria, mas ele não preserva integralmente a versão anterior e pode falhar sem bloquear a operação.

**Melhoria:** reabertura autorizada com motivo obrigatório, versão anterior preservada e novo fechamento associado à correção. Registrar solicitante e aprovador.

### C06 — P1: marcar Pix/cartão não confirma liquidação

O sistema registra o meio informado pelo operador; não existe integração de confirmação de Pix, identificador de transação, NSU ou conciliação de adquirente. Isso é aceitável como recebimento manual, desde que a interface e o procedimento operacional expressem essa responsabilidade.

**Melhoria:** distinguir pagamento informado, confirmado, cancelado e estornado; registrar referência/comprovante e conciliar. Uma futura integração deve validar confirmações no servidor e tolerar notificações repetidas.

## Mensalistas

### M01 — P0: meses de contrato são liberados sem validar o preço

**Evidência:** `backend/server.js:1220–1305`.

**Reproduzido:** um pagamento de R$ 0,01 com `meses: 12` renova por doze meses. O servidor verifica apenas que existe pagamento positivo com texto de forma de pagamento. Não compara valor com plano contratado nem exige autorização de desconto.

**Melhoria:** plano/preço no servidor, competência, vencimento, desconto permitido, cobrança e saldo pendente. Pagamento parcial deve baixar a dívida conforme política, sem liberar automaticamente todo o período. Validar quantidade de meses e valores finitos.

### M02 — P1: renovação pode ignorar vencimento futuro e avançar para mês errado

**Evidência:** `backend/server.js:1251–1259`, `152–167`; parser DATE padrão do pacote `pg` instalado.

**Reproduzido com data atual fixada em 12/11/2026:** o parser padrão de DATE retorna um objeto `Date`. `String(vencimento).slice(0, 10)` não produz `YYYY-MM-DD`; o handler descarta o vencimento futuro de 15/01/2027 e renova para 12/12/2026, antecipando indevidamente a validade.

Mesmo recebendo a data como string ISO, somar um mês a 31/01/2027 produz 03/03/2027, pelo transbordamento de fevereiro. A previsão da interface usa a mesma estratégia.

**Melhoria:** manter vencimento como data civil ISO na fronteira do banco/API; somar meses preservando o dia contratado ou o último dia válido do mês; testar anos bissextos, vencimento no dia e fusos diferentes.

### M03 — P1: pagamentos repetidos ou concorrentes podem duplicar receita e perder extensão

O recebimento não possui chave de idempotência nem documento de cobrança único. Dois cliques/reenvio podem gerar lançamentos duplicados. O cadastro é lido antes da transação, sem bloqueio da linha; pagamentos simultâneos podem calcular o mesmo vencimento inicial e gravar a mesma extensão, apesar de haver duas receitas.

**Melhoria:** cobrança identificada, pagamentos vinculados, idempotência e bloqueio transacional do contrato durante a baixa. Não basta desabilitar o botão no navegador.

### M04 — P1: cadastro, contrato e veículo estão misturados

O cadastro é único por placa. Não há contrato independente, vários veículos do mesmo cliente, limite de acessos simultâneos, vaga reservada, plano, preço individual, agenda ou competências devidas. O histórico lista parcelas de pagamento, sem uma entidade de recebimento que agrupe os meios e os meses quitados.

Na edição, o formulário envia uma placa modificada, mas `PUT /mensalistas/:id` não atualiza a placa (`frontend/script.js:1442–1460`; `backend/server.js:1173–1193`), podendo comunicar salvamento sem aplicar a alteração esperada.

**Melhoria:** separar cliente → contrato → veículos autorizados → cobranças → recebimentos. Adicionar inadimplentes/a vencer, política de suspensão, alteração de veículo auditada e recibo de mensalidade com competência e novo vencimento. CPF/telefone e placa devem ser validados e normalizados no servidor de forma consistente; campos pessoais devem ser coletados conforme a necessidade real da operação.

## Histórico, relatórios e rastreabilidade

### R01 — P1: relatórios usam bases diferentes para receitas e períodos

**Evidência:** `backend/server.js:508–581`, `620–650`, `678–726`; `frontend/script.js:1693–1720`.

O resumo geral soma `historico.valor_pago`; as mensalidades ficam em `caixa_movimentos`, portanto não integram essa receita. O caixa usa movimentos mais fallback do histórico. O resumo geral considera apenas `tipo`, sem filtro de período, embora a tela possua filtros de data para o histórico. O histórico filtra por entrada; o financeiro por saída/pagamento. Um carro que entra ontem e paga hoje aparece em períodos diferentes, sem explicação de critério.

**Melhoria:** diferenciar claramente movimento de veículos, receita recebida, faturamento e valores a receber. Usar uma base financeira única para recebimentos/estornos e permitir filtro explícito por data de entrada, saída ou recebimento.

### R02 — P1: filtros e contadores podem induzir a interpretação errada

**Reproduzido:** filtro apenas por mês é ignorado no histórico; a interface permite selecionar esse filtro. Outras combinações, como dia+mês sem ano, não correspondem integralmente ao que foi selecionado (`backend/server.js:547–566`).

O contador “transações” conta linhas de pagamento, de modo que uma saída dividida em dois meios pode contar como duas transações. O relatório financeiro usa `COUNT(*)`, incluindo casos de saída sem cobrança no fallback; o painel conta somente valores positivos. Há diferença de definição entre telas.

O agrupamento por data na interface ordena textos `DD/MM/YYYY` lexicograficamente; isso não é ordem cronológica entre meses/anos (`frontend/script.js:2285`).

**Melhoria:** filtros coerentes, período visível no título e no arquivo exportado; distinguir atendimentos, recebimentos e parcelas por meio; ordenar por data ISO antes de formatar.

### R03 — P1: auditoria sem responsável e com falha silenciosa

**Evidência:** `backend/server.js:63–72`, `1339–1352`; `backend/schema.sql:65–70`.

Há registro de ações, o que é uma base positiva, mas sem usuário, turno, terminal, versão anterior e nova ou correlação da requisição. Erro ao gravar auditoria apenas gera aviso, enquanto a operação segue. Não há uma tela de auditoria na interface.

**Melhoria:** trilha transacional para operações críticas; responsável, ação, entidade, valores antes/depois, motivo e identificador de correlação; consulta por período, usuário e tipo. Controlar permissões e retenção dos próprios registros de auditoria.

### R04 — P2: histórico e relatórios precisam de recursos de gestão e escala

As listagens de histórico, mensalistas, turnos e fechamentos não têm paginação. O histórico não mostra detalhamento dos meios divididos nem ligações navegáveis com turno/cobrança. Não há exportação CSV/PDF de relatórios na interface revisada.

**Melhoria:** paginação no servidor; busca combinada por placa, período, status, operador, tipo e pagamento; extrato navegável do recebimento; exportações identificadas e totais consistentes. Para gestão: ocupação por horário, permanência média, ticket médio bem definido, receita por origem, gratuidades/cancelamentos, diferenças de caixa, inadimplência e comparação por período.

## Banco de dados, backup e continuidade

### D01 — P0: backup é incompleto e restore aceita apagar dados com objeto vazio

**Evidência:** `backend/server.js:1355–1470`.

**Reproduzido em banco simulado:** a exportação inclui apenas histórico, configurações, mensalistas e movimentos. Não inclui turnos, fechamentos e auditoria. O cache de veículos também não é exportado, embora seja secundário e reconstruível.

Enviar `{}` para `/restore` executa quatro `DELETE` e retorna sucesso. As propriedades ausentes viram arrays vazios; não há validação de versão, estrutura ou conteúdo antes de iniciar a substituição. O aviso de confirmação no navegador não protege esse endpoint.

Ao restaurar, os turnos e fechamentos antigos permanecem, enquanto os movimentos são substituídos: a base pode misturar registros de momentos diferentes. Os selects do backup também não usam uma única fotografia transacional.

**Melhoria:** formato versionado com inventário completo, validação estrita antes de qualquer alteração, backup consistente, prévia dos totais e arquivo de segurança anterior. Restringir restauração ao administrador e testar em uma base separada. Um payload vazio deve ser rejeitado. Políticas automáticas de backup precisam incluir verificação de recuperação.

### D02 — P1: tamanho do arquivo e sequências podem impedir recuperação

`express.json()` é usado sem limite específico (`backend/server.js:18`). O pacote body-parser instalado define padrão de 102.400 bytes (`backend/node_modules/body-parser/lib/utils.js:47`). O sistema pode exportar um backup que a própria API rejeita por tamanho no restore. A hospedagem pode impor limites adicionais, não verificados nesta revisão.

O restore insere IDs explícitos nas tabelas `BIGSERIAL` sem realinhar sequências. Em uma base nova, futuros inserts podem colidir com IDs restaurados. Se um registro importado não possui ID, o código fornece `NULL` explicitamente em vez de usar o default, produzindo outro modo de falha.

**Melhoria:** processo de importação dimensionado e validado, restauração integral com relacionamentos preservados, realinhamento de sequências e teste de criação de novos registros depois do restore.

### D03 — P1: faltam garantias de integridade e validações de configuração

`backend/schema.sql` não define chaves estrangeiras para movimentos e não restringe valores monetários negativos, estados ou combinações de campos. Tarifas/vagas são atualizadas sem validação de faixa, tipo ou conjunto permitido (`backend/server.js:1043–1097`). A atualização de várias configurações não é atômica: parte pode ser aplicada antes de uma falha. A inicialização reaplica DDL em vez de usar migrações versionadas (`backend/db.js:26–113`).

**Melhoria:** adicionar invariantes no banco e validação no servidor, saneando previamente dados legados; migrações versionadas; atualização transacional; histórico das tarifas com vigência. Não criar restrições em produção sem verificar duplicidades e inconsistências existentes.

### D04 — P1: disponibilidade e segurança de transporte precisam de revisão de implantação

`/health` confirma o serviço HTTP, mas não a prontidão do banco. A falha de `initDb` é capturada e o servidor continua; diversas rotas aguardam a promessa resolvida após o erro e tentam operar mesmo assim (`backend/server.js:74–78`; `backend/routes/plates.js:56`).

Quando `PGSSLMODE=require`, a conexão usa `rejectUnauthorized: false` (`backend/db.js:21`), exigindo revisão da configuração de certificados para verificar a identidade do servidor do banco. Isso é uma constatação do cliente local, não prova de ataque ou de falha na hospedagem.

**Melhoria:** separar liveness e readiness, tratar indisponibilidade com resposta adequada e impedir mutações sem schema pronto; revisar HTTPS/certificados, origens permitidas e restrição de rede conforme o ambiente real. Os limites de consulta de placas são locais à instância, conforme já indicado no README, e não substituem controle global em várias instâncias.

## Comprovantes e uso diário

- O comprovante de entrada imprime tipo, hora e tarifas, mas não exibe placa e identificador legível, apesar de ter o QR (`frontend/script.js:1347–1369`). Acrescentar identificação do estacionamento, placa, número do ticket, terminal/operador e regras aplicáveis.
- Preservar os dados do recibo original para reimpressão: atualmente a reimpressão de entrada consulta as tarifas atuais do navegador. O histórico não oferece reimpressão equivalente do recibo final já pago.
- Oferecer recibo de mensalidade e fechamento, com referências que permitam localizar a operação. Requisitos fiscais específicos não foram avaliados nesta revisão.
- Trocar prompts/alerts dos fluxos importantes por formulários consistentes; impedir envio duplicado enquanto processa e mostrar uma referência da operação quando houver dúvida após queda de conexão.
- Melhorar filtros e tabelas em telas pequenas, foco de teclado nos modais, botões com nomes acessíveis e operação rápida por placa/leitor. O teste móvel existente cobre o formulário de entrada, não todos os relatórios.
- Definir procedimento para ausência de internet, indisponibilidade de fornecedor, QR ilegível, pagamento pendente, placa repetida e perda de ticket. O cache atual não é uma fila de operações offline com reconciliação.

## Fluxo profissional recomendado

1. **Identificar o operador:** sessão válida e permissões apropriadas.
2. **Abrir caixa/turno:** terminal, operador, fundo inicial e referência operacional.
3. **Registrar entrada:** validar placa única ativa, capacidade e eventual contrato, emitir ticket com tarifa aplicável.
4. **Preparar saída:** obter cotação do servidor e justificar qualquer exceção.
5. **Receber:** registrar uma operação identificada com seus meios de pagamento e confirmar conforme o meio/procedimento adotado.
6. **Liberar:** baixar uma única permanência e gravar financeiro/auditoria de forma atômica; se houver cancela integrada, tratar confirmação e repetição segura do comando.
7. **Fechar turno:** conferir dinheiro, outros meios, sangrias e suprimentos; explicar divergências; preservar os veículos que continuam no pátio.
8. **Consolidar o dia:** agrupar os turnos e conciliar os recebimentos; corrigir por versão/estorno, preservando o registro anterior.
9. **Recuperar:** manter backup automático e verificar restauração integral em ambiente separado.

## Ordem recomendada de implementação

| Etapa | Entregas | Critério para concluir |
|---|---|---|
| 1. Proteger os dados e o dinheiro | Corrigir HTML inseguro; proteger restore; autenticação individual/permissões; preço e benefício mensalista no servidor; saída transacional | Operador sem permissão não altera finanças/administração; valor indevido é rejeitado; falha parcial não deixa baixa ou pagamento isolado |
| 2. Tornar caixa e turno efetivos | Vínculo de movimentos, fundo, sangria/suprimento, conferência, fechamento e reabertura versionada; concorrência e idempotência | Dois terminais não duplicam turno, vaga, cobrança ou pagamento; fechamento reproduz os movimentos do turno e explica a diferença física |
| 3. Corrigir mensalistas e relatórios | Datas civis, contratos/cobranças, competências, atrasos, cadastros; filtros e fonte financeira única; auditoria consultável | Renovação preserva período pago; receita confere entre telas; histórico local não recria entrada encerrada |
| 4. Consolidar a operação | Backup completo testado, migrações, prontidão/observabilidade, exportações, recibos e produtividade | Recuperação validada em base separada; relatórios e comprovantes reproduzíveis; procedimento de contingência documentado |

## Testes que faltam para aceitar as correções

- Usuário não autenticado, sessão expirada, operador e supervisor em todas as rotas sensíveis.
- Mesma placa e última vaga disputadas por dois terminais, com PostgreSQL de teste.
- Saída por identificador incorreto, pagamento dividido com falha no segundo lançamento, repetição após timeout e tentativa de cancelamento concorrente.
- Recebimento sem turno; dois turnos no mesmo dia; turno atravessando meia-noite; fechamento com diferença; reabertura autorizada.
- Mensalista vencido/inativo, pagamento parcial, pagamento repetido, renovação antecipada, 31 de janeiro, fevereiro bissexto e vencimento retornado pelo driver real.
- Conciliação entre histórico, recebimentos, mensalidades, estornos, dashboard e fechamento, com critérios de data declarados.
- Backup com todas as entidades, rejeição de arquivo vazio/inválido, volume maior que o limite atual, restauração em base vazia e criação de registros depois dela.
- Textos maliciosos exibidos como texto e logout que remove informações operacionais do navegador.

A aprovação desses testes deve ocorrer em ambiente separado com banco real de teste. Os testes atuais continuam úteis para placas/câmera, mas sua aprovação não atesta as regras financeiras descritas aqui.
