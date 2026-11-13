-- Preserva tarifas, recebimentos e limites dos comprovantes já emitidos.
INSERT INTO configuracoes (chave,valor,descricao) VALUES
 ('expediente_inicio','08:00','Início do expediente'),
 ('expediente_fim','18:00','Fim do expediente')
ON CONFLICT (chave) DO NOTHING;
UPDATE configuracoes SET descricao='Valor fixo do período pré-pago (R$)' WHERE chave='valor_diaria';
