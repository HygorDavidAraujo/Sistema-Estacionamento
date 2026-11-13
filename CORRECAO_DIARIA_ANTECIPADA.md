# Diária antecipada até o fechamento

Correção local em 13/11/2026 conforme a definição do usuário: a diária vale até o horário de fechamento combinado pelo operador, com pagamento antecipado. A referência de dez horas não é um período fixo de cobrança. O usuário também definiu que atrasos devem ser cobrados pela tarifa avulsa.

## Atendimento

1. Na entrada, selecione **Diária** e preencha **Retirar até**, com a data e o horário combinados de fechamento. O horário é interpretado no fuso configurado para o estacionamento (`APP_TIMEZONE`, padrão `America/Sao_Paulo`), independentemente do fuso do navegador.
2. O sistema consulta o valor vigente da diária no servidor. Confirme os meios de pagamento, inclusive pagamento dividido. O próprio usuário precisa ter um turno aberto.
3. Somente a confirmação integral registra entrada, recebimento, auditoria e comprovante, em uma única transação. Se uma parcela falhar, toda a operação é revertida; reenviar a mesma confirmação não duplica a cobrança.
4. O ticket de entrada reúne o pagamento e o horário limite, com QR e identificação do turno nos formatos compactos de **80 mm e 58 mm**. O pátio mostra a diária paga e o limite combinado. É possível reimprimir o documento no pátio e pelo histórico.
5. Retirar até o horário combinado, inclusive no instante exato, não gera nova cobrança. Depois do limite, o servidor calcula somente o tempo excedente pela tarifa avulsa preservada na entrada. Não se reinicia a tolerância de entrada.

## Cálculo do atraso

A primeira hora iniciada de atraso usa o valor da primeira hora avulsa; cada hora adicional iniciada usa o valor da hora adicional. Não há conversão em outra diária nem repetição automática após 24 horas.

Exemplo com diária de R$ 25, primeira hora de R$ 5 e adicional de R$ 2,50: para retirada combinada às 18h, uma saída até 18h deve zero; às 18h01 deve R$ 5; às 19h01 deve R$ 7,50. Esses valores são adicionais aos R$ 25 recebidos na entrada. A saída mostra separadamente o valor antecipado e o valor pago pelo atraso.

A cotação de saída é conferida novamente na confirmação quando existe diária antecipada: se ultrapassar o limite combinado ou mudar a faixa de atraso, o servidor exige consultar o valor novamente. Uma cotação de valor zero anterior ao fechamento não prolonga o período quitado.

## Caixa, histórico e registros anteriores

O recebimento da diária fica no turno de entrada. Se outro operador receber o atraso após a troca de turno, somente esse adicional entra no novo turno. O relatório de caixa soma os recebimentos uma única vez; o histórico da permanência mostra a soma da antecipação e do eventual atraso. O comprovante original da entrada permanece preservado.

Entradas pagas não podem ser canceladas como se não tivessem cobrança. O procedimento normal é registrar sua saída. Estorno financeiro não foi adicionado nesta correção.

Diárias antigas sem horário combinado e sem recebimento antecipado registrado permanecem identificadas como legadas. O sistema não presume que foram pagas nem inventa um limite de retirada. Para esses registros, a saída cobra uma única diária da tarifa preservada ou vigente quando não houver tarifa salva; não multiplica períodos de 24 horas nem presume atraso. Os comprovantes originais anteriores continuam armazenados como foram registrados.

O backup operacional versão 2 inclui os novos campos da diária e seus movimentos/comprovantes. Arquivos anteriores continuam restauráveis pelas regras existentes; campos de antecipação ausentes permanecem nulos, sem atribuição retroativa.

## Publicação e validação

Faça commit/push dos arquivos alterados e novos, incluindo `backend/migrations/003-prepaid-daily.sql`. O deploy pelo GitHub/Vercel aplica a migração aditiva automaticamente na primeira requisição que precisa do banco. Não é necessário executar SQL manual no Neon nem adicionar variáveis de ambiente. A migração preserva turnos e registros existentes.

Os testes usam PostgreSQL isolado em memória e o navegador Edge, sem acessar o banco operacional ou publicar alterações. Cobrem pagamento integral, turno responsável, rollback entre parcelas, idempotência, horário combinado, atraso, tarifa preservada, troca de turno, relatório sem duplicação, reimpressão e backup/restauração.

Resultado: **61 testes de lógica/API e 15 testes de navegador aprovados**. Os quatro PDFs de diária (entrada e saída, em 80 mm e 58 mm) ficaram em uma página cada, sem transbordamento horizontal. `git diff --check` também passou.

Exemplos locais gerados: [entrada 80 mm](artifacts/diaria-entrada-80mm.pdf), [entrada 58 mm](artifacts/diaria-entrada-58mm.pdf), [saída 80 mm](artifacts/diaria-saida-80mm.pdf) e [saída 58 mm](artifacts/diaria-saida-58mm.pdf). Os artefatos de teste ficam ignorados no Git. O avanço e o corte físico continuam dependentes da impressora/driver e não foram testados no equipamento.
