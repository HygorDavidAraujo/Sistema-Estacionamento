# Passo 3 — mensalistas, contratos, histórico e relatórios

Implementação local em 13/11/2026. Regras confirmadas pelo usuário nesta etapa: estacionamento pré-pago; mensalidade de **30 dias a partir do pagamento**; avisos em tela dois dias antes, no vencimento e após vencer; oferecer renovação na saída de mensalista vencido e, se não renovar, cobrar a permanência avulsa após o período quitado até a retirada.

## Mensalidade pré-paga

- Cada período corresponde a **30 dias corridos**, incluindo fevereiro e anos bissextos. Não se soma um mês de calendário. É possível receber de 1 a 24 períodos, com valor calculado no servidor.
- Para cliente novo ou vencido, a quitação inicia os 30 dias na data do pagamento. Se ainda há validade, a renovação acrescenta os dias ao período já quitado, preservando o tempo restante. Não há cobrança automática dos meses em que o cliente ficou sem usar o estacionamento.
- A validade é uma data civil: o benefício inclui o dia do vencimento até seu término no fuso do estacionamento. Na tela, o cliente aparece como **Vence em até 2 dias**, **Vence hoje** ou **Vencido**; os demais estados incluem em dia, sem pagamento, suspenso e cancelado.
- Os avisos ficam visíveis na central de operação e são atualizados junto das consultas operacionais. A lista principal mostra até seis avisos; o botão abre os mensalistas, onde os filtros e a paginação permitem consultar os demais. O servidor prioriza os vencimentos de hoje e os próximos dois dias.

## Cadastro, contrato e veículos

O cliente mantém identificação própria, um contrato com plano e preço por 30 dias, situação, início e limite de veículos simultâneos. Pode ter uma placa principal e outras placas autorizadas. CPF e telefone são opcionais; quando preenchidos, são normalizados e validados no servidor.

Supervisor e administrador podem criar e alterar contratos. Alterações exigem justificativa de 10 a 255 caracteres e preservam o antes/depois na auditoria. A troca da placa principal é efetivamente salva; uma placa não pode pertencer a outro cliente. Remover um veículo que está no pátio exige registrar sua saída antes. O servidor valida também o limite simultâneo na entrada.

O cadastro novo não concede validade nem gera receita. O preço geral da configuração serve como referência para novos contratos; cada contrato guarda seu preço, e reajustes passam a valer para novas cobranças. Uma cobrança já emitida conserva o preço contratado, inclusive se estiver parcialmente recebida.

## Cobranças e recebimentos

Em **Mensalistas → Receber**, o sistema consulta contrato, período e saldo no servidor. É possível emitir a cobrança sem receber ou confirmar o recebimento diretamente. Há somente uma cobrança aberta/parcial por contrato; os demais períodos devem ser quitados ou uma cobrança sem pagamento deve ser cancelada com justificativa antes de emitir outra.

O campo **Receber agora** permite pagamento parcial, inclusive dividido em vários meios. O parcial reduz o saldo, aparece no caixa e emite comprovante, mas **não libera o novo período**. A quitação do saldo é que define a validade; se ocorrer dias depois do primeiro parcial, os 30 dias começam na quitação, preservando eventual validade ainda em vigor. Datas mostradas antes disso são previsões.

Cada confirmação pertence ao turno aberto do próprio usuário. Parcelas, saldo, validade, auditoria e comprovante são gravados na mesma transação. Falha em uma parcela desfaz toda a confirmação. Reenvios da mesma operação não duplicam o recebimento. Uma revisão do contrato/saldo impede confirmar uma tela desatualizada ou duas confirmações concorrentes da mesma previsão.

Contrato suspenso pode receber para regularização, mas o pagamento não o reativa automaticamente. Suspensão ou cancelamento impede novas entradas como mensalista. Cobranças com pagamento não podem ser canceladas para apagar o recebimento; estornos não foram acrescentados nesta etapa.

## Mensalista vencido na saída

A tela pergunta se o cliente deseja renovar. Ao renovar, mostra o comprovante da mensalidade e o botão **Continuar a saída do veículo**, que consulta novamente a validade e o valor. Se optar por não renovar, o servidor registra essa escolha e calcula a tarifa avulsa após o término do período quitado, sem cobrar retroativamente o tempo já coberto. O recebimento avulso pertence ao turno da saída.

A cobertura quitada é preservada na entrada e confrontada com renovações posteriores. Alterar ou suspender um contrato não transforma o período já concedido àquela permanência em débito retroativo. Uma cotação anterior ao vencimento ou a uma renovação precisa ser atualizada se o valor/condição mudar antes da confirmação.

Para registros antigos sem qualquer validade recuperável, não se inventa cobertura: o operador pode regularizar o contrato ou prosseguir com o cálculo avulso baseado na permanência conhecida. A opção escolhida fica registrada.

## Histórico, gestão e exportação

- **Mensalistas:** busca por nome, CPF e qualquer placa autorizada; situação; resumo de vencimentos e saldo de cobranças emitidas; paginação; CSV; contrato, veículos, cobranças e recebimentos agrupados por operação.
- **Histórico de permanências:** data de entrada ou saída, intervalo, dia/mês/ano independentes, placa, categoria, situação e operador de entrada. O filtro apenas por mês passa a funcionar. Paginação e CSV evitam listagens silenciosamente cortadas.
- **Financeiro:** base única de recebimentos por data de pagamento, incluindo mensalidades, diárias antecipadas e saídas/atrasos. Pagamentos divididos aparecem como um recebimento com várias parcelas. Fundo, sangria e suprimento ficam fora da receita. O fallback de registros antigos não repete valores que já possuem movimento financeiro.
- **Filtros financeiros:** período, origem, meio, placa, operador que recebeu e turno. O filtro de meio soma apenas as parcelas daquele meio. O total do filtro permanece completo durante a paginação.
- **Cobranças em aberto:** mostra somente cobranças antecipadas efetivamente emitidas, seus recebimentos e saldos. Um cadastro vencido sem cobrança emitida não vira dívida automática.
- **Auditoria:** consulta por data do registro, ação e nome do responsável, com detalhes e paginação. Restrita a supervisor/administrador.
- **Caixa:** turnos, conferências e resumos legados têm paginação independente. O consolidado mantém todas as conferências elegíveis do período, sem duplicar versões substituídas.

O resumo identifica as bases: movimento de veículos pela data de entrada/saída selecionada e receita pela data de recebimento. Situação e operador de entrada filtram os indicadores operacionais; os financeiros usam período, placa e categoria. A média financeira é por recebimento, e não por parcela. Registros financeiros legados sem identificador de operação são contados individualmente, sem presumir quais parcelas pertenciam ao mesmo atendimento.

O detalhe do contrato apresenta as 100 cobranças mais recentes. Os recebimentos possuem paginação própria e o relatório financeiro permite consultar/exportar períodos anteriores.

CSV financeiro e histórico incluem critérios/filtros; células são protegidas contra interpretação como fórmulas. A exportação abrange o filtro completo até 20 mil registros; acima disso, exige restringir a consulta. A impressão/PDF financeiro usa a página exibida e informa que os totais abrangem o filtro completo; o CSV reúne todas as linhas. Recebimentos e linhas exportados são consultados em uma fotografia transacional consistente.

## Comprovantes e preservação de dados

Os modelos compactos de **58 mm e 80 mm** continuam disponíveis. A mensalidade informa os 30 dias, contrato, cobrança, competência, pagamento, saldo parcial quando houver e validade efetivamente liberada. O documento parcial avisa explicitamente que não concede o novo período. Cada recibo permanece original para reimpressão, mesmo depois da quitação do saldo.

A migração mantém a validade dos clientes anteriores, prepara contrato básico com o preço da tabela e autoriza sua placa existente. Não cria dívida, pagamento ou recibo retroativo. A opção de regularização de validade anterior fica no histórico do contrato, é restrita ao supervisor/administrador e exige justificativa; só funciona se não houver cobranças não canceladas. Não gera receita.

O backup operacional passa à **versão 3**, incluindo contratos, veículos e cobranças. Versões 1 e 2 continuam aceitas: seus dados e validades são preservados e contratos básicos são preparados sem inventar cobranças. Credenciais e sessões continuam fora do arquivo operacional.

## Publicar pelo GitHub e Vercel

1. Faça commit/push de todos os arquivos novos e alterados, incluindo `backend/migrations/004-subscriptions-reports.sql`, as rotas e os serviços novos de contratos/relatórios e `frontend/js/subscription.service.js` e `frontend/js/report.service.js`.
2. Aguarde o deploy pelo projeto já conectado ao GitHub. Não há dependências novas nem variáveis de ambiente adicionais.
3. A migração aditiva é aplicada automaticamente na primeira requisição que precisa do banco. Não é necessário executar SQL manual no Neon.
4. Confira o preço e a validade dos contratos migrados, os avisos e os comprovantes no ambiente publicado. Teste a impressão física nos dois modelos usados no estacionamento.

Nenhum commit, push, deploy ou alteração no banco operacional foi executado nesta etapa. Os testes usam PostgreSQL isolado em memória e Edge.

## Validação

Execute `npm test` e `npm run test:browser` dentro de `backend/`. A bateria cobre os fluxos anteriores, os períodos exatos de 30 dias, os avisos, parcelas e quitação, rollback, revisões, preço preservado, autorização por veículo, escolha de renovação na saída, relatório sem duplicação, filtros, paginação, CSV, auditoria, migração e restauração das versões anteriores.

Resultado final: **74 testes de lógica/API e 17 testes de navegador aprovados**, sem falhas. Os comprovantes de 58 mm e 80 mm ficaram em uma página, sem transbordamento horizontal. `git diff --check` também passou.

Evidências locais: [parcial 80 mm](artifacts/mensalidade-parcial-80mm.pdf), [parcial 58 mm](artifacts/mensalidade-parcial-58mm.pdf) e [relatório financeiro em PDF](artifacts/relatorio-recebimentos.pdf). Os arquivos de evidência ficam ignorados no Git. A impressão física não foi testada no equipamento.

O [passo 4 — recuperação e consolidação operacional](PASSO_4_IMPLEMENTACAO.md) está implementado localmente. A configuração atual usa backup manual, sem armazenamento adicional ou agendamento. Consulte seu roteiro para publicar e habilitar as opções de cifragem e recuperação de acesso.
