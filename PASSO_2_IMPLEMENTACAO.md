# Passo 2 — caixa por turno e fechamento conferido

Implementação local em 13/11/2026, considerando a confirmação do usuário: **um caixa por vez**. A publicação continua pelo fluxo GitHub → Vercel. O passo 3 depende de nova autorização.

## Funcionamento

- Abertura com fundo inicial explícito, horário do servidor e usuário responsável. Há somente um turno aberto no sistema, com restrição no PostgreSQL inclusive para pedidos simultâneos entre instâncias da hospedagem.
- Cada saída e recebimento de mensalidade pertence ao turno aberto do próprio usuário. Saída gratuita também exige turno e fica registrada, sem criar receita fictícia. Entradas avulsas e de mensalistas podem continuar sendo registradas sem turno aberto. Diárias novas exigem pagamento antecipado no próprio turno e horário combinado de retirada, conforme a [correção da diária](CORRECAO_DIARIA_ANTECIPADA.md).
- A troca de operador exige encerrar o turno atual e abrir outro com o novo usuário. O fundo do novo turno deve refletir o dinheiro efetivamente entregue; não há transferência automática presumida. Não é possível desativar o responsável enquanto seu turno estiver aberto.
- Sangria e suprimento possuem valor, justificativa de 10 a 255 caracteres, responsável, horário e comprovante. A sangria não pode superar o dinheiro disponível. Fundo e ajustes ficam separados da receita.
- Dinheiro esperado na gaveta = fundo inicial + recebimentos em dinheiro + suprimentos − sangrias. Pix e cartões são conferidos separadamente. Pagamento dividido representa um recebimento com várias parcelas, sem multiplicar a quantidade de recebimentos.
- O fechamento exige informar a contagem de dinheiro, Pix, crédito e débito, inclusive zero. Se houver novo recebimento ou ajuste após a consulta do resumo, o servidor exige atualizar a conferência antes de fechar.
- Diferenças exigem justificativa e deixam a conferência aguardando aprovação de supervisor ou administrador. O turno deixa de receber e libera o caixa para a próxima abertura. A aprovação mantém os valores, a diferença original e a identificação de quem aprovou.
- Supervisor ou administrador pode reabrir um turno com justificativa, desde que nenhum outro esteja aberto e seu responsável continue ativo. A conferência anterior permanece preservada e marcada como substituída; o próximo fechamento gera outra versão. Os movimentos anteriores continuam no mesmo turno.
- Fechar caixa não dá saída nem cancela veículos: o pátio continua com as entradas ativas para o próximo operador.
- Abertura, ajustes, fechamento, aprovação e reabertura possuem auditoria e proteção contra duplicação no reenvio da mesma operação.

## Histórico e consulta

O histórico apresenta turnos, versões de conferência, recebimentos, diferenças, ajustes e aprovação. O operador consulta seus próprios turnos; supervisor, administrador e financeiro podem consultar os demais. Aprovar diferenças, reabrir e encerrar registros legados são ações de supervisor/administrador.

O consolidado considera a **data operacional de abertura do turno**, inclusive quando o fechamento acontece depois da meia-noite. Soma somente a conferência atual dos turnos encerrados ou aguardando aprovação. Versões substituídas e turnos abertos ficam fora desse consolidado; os recebimentos do turno aberto aparecem no painel do caixa. A soma do dinheiro esperado/contado representa conferências de vários turnos e pode conter o mesmo fundo reapresentado em turnos sucessivos: não representa receita nem o saldo físico atual.

O [passo 3](PASSO_3_IMPLEMENTACAO.md) acrescentou paginação independente para turnos, conferências e resumos diários antigos. O consolidado do período considera todos os turnos elegíveis, independentemente da página exibida.

## Dados anteriores e backup

Turnos anteriores à migração ficam como **legados**. Seus recebimentos e resumos antigos são preservados, sem atribuir retroativamente valores a um operador ou turno. Um supervisor/administrador pode encerrar administrativamente um registro legado aberto, informando o motivo, sem produzir uma conferência financeira inventada. Registros legados não bloqueiam a abertura do novo caixa.

O backup operacional passou à versão 2, incluindo ajustes, conferências, versões e operações de caixa. A restauração mantém as validações e a transação integral. Backups da versão 1 são aceitos e convertidos para registros legados; arquivos sem versão continuam fora da restauração automática. Usuários, senhas e sessões continuam fora do arquivo operacional.

## Impressão

Abertura, sangria, suprimento e fechamento usam os mesmos modelos compactos de **80 mm e 58 mm**, com altura calculada pelo conteúdo. Saída e mensalidade também identificam o turno. O histórico permite reimprimir a abertura, os ajustes e as conferências com seus dados originais.

A conferência imprime fundo, receita, ajustes, valores esperados/conferidos, diferenças por meio de pagamento, versão, responsáveis e quantidade de veículos mantidos no pátio. A reimpressão preserva a situação no momento do registro; a aprovação posterior é consultada no histórico, sem alterar o documento original.

Exemplos locais: [fechamento 80 mm](artifacts/fechamento-caixa-80mm.pdf) e [fechamento 58 mm](artifacts/fechamento-caixa-58mm.pdf). Os PDFs e imagens em `artifacts/` são evidências geradas pelos testes e ficam ignorados no Git. A impressão física e o avanço/corte dependem do equipamento e ainda precisam ser conferidos na impressora do estacionamento.

## Publicar no GitHub e Vercel

1. Faça commit/push de todos os arquivos alterados e novos desta etapa. Inclua especialmente `backend/migrations/002-cash-shifts.sql`, `backend/routes/cash.js`, `backend/services/cash-domain.js` e `frontend/js/cash.service.js`, além dos testes e da documentação. Selecionar somente arquivos já rastreados deixa partes essenciais fora do deploy.
2. Aguarde o deploy do projeto já conectado ao GitHub. Esta etapa não adiciona dependências nem exige novas variáveis de ambiente.
3. A primeira requisição que precisa do banco aplica a migração aditiva `002-cash-shifts`, sob o controle de versão existente. O pacote da função já inclui os arquivos SQL pelo `vercel.json`. A migração preserva os dados anteriores.
4. Entre com seu usuário, confira os registros legados no histórico e abra o novo turno informando o fundo real. Confira abertura, recebimento e impressão no ambiente publicado.

Nenhum commit, push, deploy ou alteração no banco operacional foi executado nesta implementação local. Os testes usam banco isolado em memória, sem acessar as credenciais da hospedagem.

## Validação

Comandos: `npm test` e `npm run test:browser` dentro de `backend/`.

Resultado final: **53 testes de lógica/API e 14 testes de navegador aprovados**, sem falhas. A verificação `git diff --check` também passou.

A bateria de lógica/API cobre migração desde a versão anterior, exclusividade do caixa, concorrência, responsável, reenvios, parcelas, saídas gratuitas, mensalidades, ajustes, conferência desatualizada, diferença, aprovação, troca de operador, reabertura, versões, meia-noite e backup/restauração das versões 1 e 2.

O navegador Edge valida a operação pela interface, incluindo fundo, suprimento, sangria, diferença, aprovação e reabertura, além dos fluxos anteriores de autenticação, entrada, saída e mensalidade. Os comprovantes de fechamento são gerados nos dois formatos, em uma página cada e sem transbordamento horizontal.
