# Reconhecimento automático de mensalistas na entrada

A entrada consultava o cadastro de mensalista somente quando o operador marcava manualmente a opção. O servidor também condicionava a validação da mensalidade a essa marcação, permitindo registrar uma placa quitada como avulsa por engano.

## Comportamento corrigido

- Digitar a placa ou usar uma placa confirmada pela câmera consulta automaticamente o cadastro no próprio servidor. A consulta independe da API externa de marca/modelo e reconhece placa principal e placas adicionais autorizadas.
- Com contrato ativo, iniciado e mensalidade válida, seleciona **Mensalista**, preenche os dados e mostra nome e validade. O período pré-pago fica desabilitado para evitar uma cobrança acidental.
- **Vence em até dois dias** e **vence hoje** continuam elegíveis; o dia do vencimento é válido até seu término no fuso do estacionamento. O aviso fica visível na entrada.
- Mensalidade vencida, sem quitação, contrato suspenso, cancelado ou ainda não iniciado exibem aviso e não concedem o benefício automaticamente. O cadastro ou pagamento parcial isolado não concede validade.
- Trocar a placa limpa a identificação anterior. Respostas atrasadas, consultas de uma sessão encerrada e consultas de um formulário fechado são descartadas. Reabrir a entrada consulta novamente.
- Ao registrar, a interface confere novamente o cadastro e o servidor revalida a placa na transação. Mesmo se o navegador enviar `mensalista: false` ou omitir o campo, uma placa com benefício válido é registrada como mensalista. O limite simultâneo do contrato continua obrigatório.
- Uma tentativa de confirmar período pré-pago para uma placa com benefício válido é recusada sem gravar pagamento. A categoria confirmada pelo servidor é usada no comprovante e no cartão do pátio.

O reconhecimento identifica o benefício; o operador continua confirmando a entrada. As regras de saída após vencimento permanecem: oferecer renovação e, sem renovação, cobrar o avulso após o término da cobertura paga. Entradas antigas não são recategorizadas retroativamente.

## Publicação e conferência

Faça commit/push dos arquivos alterados e aguarde o deploy pelo GitHub → Vercel. Não há dependência nova, variável adicional, migração SQL ou necessidade de executar comandos no Neon. A consulta usa a hospedagem e o banco existentes, sem conectar armazenamento ou fornecedor adicional.

Depois de publicar, abra a entrada e digite uma placa de contrato quitado: confira nome, validade, seleção automática e categoria no ticket/pátio. Repita com uma placa adicional e uma mensalidade vencida. Para registros antigos lançados como avulsos, confira o atendimento com o responsável antes de receber; esta alteração vale para as novas entradas.

## Validação

Os testes usam banco PostgreSQL isolado em memória e Edge. Cobrem reconhecimento de placa principal/adicional sem marcação manual, limite simultâneo, impedimento de diária indevida, validade nos dias de aviso/vencimento, expiração, suspensão, cancelamento, início futuro, pagamento parcial, atualização do pátio e descarte de consultas antigas. Resultado acumulado: **92 testes de lógica/API e 24 de navegador aprovados**, sem falhas. Os comprovantes compactos de 58 mm e 80 mm continuam em uma página nos testes de impressão.
