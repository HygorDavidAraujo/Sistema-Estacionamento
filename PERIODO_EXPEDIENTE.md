# Período pré-pago e horário de expediente

A antiga Diária passa a ser **Período pré-pago**. A entrada não pede data ou horário de saída do cliente. A identificação foi atualizada na entrada, pátio, histórico, relatórios, CSV e comprovantes.

## Regra

- Preço fixo pago antecipadamente no turno do operador que registra a entrada.
- Cobertura da entrada até o **fechamento do expediente ou 10 horas após a entrada, o que ocorrer primeiro**.
- O cliente pode sair antes, sem desconto, redução proporcional ou reembolso automático.
- Após o limite, cobra-se apenas o excedente pela tarifa avulsa preservada na entrada: primeira hora iniciada pela tarifa inicial e demais horas iniciadas pelo adicional, sem nova tolerância. O valor antecipado não é cobrado novamente.
- O servidor calcula o limite ao confirmar a entrada. Um horário enviado manualmente pelo navegador não pode ampliar a cobertura.
- O período só pode começar dentro do expediente configurado. A configuração não encerra turnos nem registra saídas automaticamente.

Exemplo com expediente das 08h às 18h e período de R$ 25:

| Entrada | Limite | Preço |
|---|---|---|
| 08h | 18h | R$ 25 |
| 14h | 18h | R$ 25 |
| 17h50 | 18h | R$ 25 |

Entrar às 14h e sair às 15h continua custando R$ 25. Após 18h, há cobrança de excedente. Em expediente mais longo, por exemplo 07h às 21h, quem entra às 08h tem cobertura até 18h, respeitando as 10 horas máximas.

## Configurar e publicar

Em **Configurações**, o administrador define **Valor fixo do período**, **Início do expediente** e **Fim do expediente**. Os horários devem ser válidos e diferentes. Expediente noturno é aceito: 19h às 05h, por exemplo, compreende a noite e a madrugada seguinte. O cálculo usa o fuso do estacionamento (`APP_TIMEZONE`, já existente).

A migração prepara **08:00 e 18:00**, preservando o preço anterior. Confira esses horários e ajuste à operação real antes de registrar novos períodos. Mudanças de preço ou expediente valem para novas entradas; veículos já pagos conservam a tarifa e o limite gravados.

Faça commit/push dos arquivos novos e alterados, incluindo `backend/migrations/006-work-period.sql` e `backend/services/period-domain.js`, e aguarde o deploy da Vercel. A migração é aplicada automaticamente na primeira requisição que precisa do banco. **Não precisa executar SQL no Neon, criar variáveis ou conectar serviços adicionais.** Depois de publicar, atualize a página e salve o expediente real.

## Preservação

O reconhecimento automático de mensalista quitado continua ativo e evita cobrança de período indevida. O limite simultâneo do contrato permanece obrigatório.

Valores, horários e comprovantes anteriores permanecem armazenados. Antecipações antigas com limite escolhido pelo operador não são encurtadas retroativamente. Registros legados sem antecipação conservam o tratamento anterior. A apresentação usa a nova identificação sem perder os dados importantes do documento.

Os identificadores internos antigos foram mantidos para compatibilidade com histórico, recibos e backups. O backup operacional continua na versão 3; backups sem expediente recebem os horários padrão ao restaurar. Os modelos compactos de **58 mm e 80 mm** informam limite, valor antecipado e eventual excedente.

## Verificação

Testes com PostgreSQL isolado em memória e Edge cobrem limite de 10 horas, expediente noturno, fuso, recusa fora do expediente, configuração, horário adulterado, chegada perto do fechamento sem desconto, saída antecipada, excedente, pagamento dividido, rollback, repetição sem duplicidade, migração, backup/restauração e impressão compacta. Resultado acumulado: **95 testes de lógica/API e 25 de navegador aprovados**, sem falhas. O banco operacional e a impressora física não foram acessados.
