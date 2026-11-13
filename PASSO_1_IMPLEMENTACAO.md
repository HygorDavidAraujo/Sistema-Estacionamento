# Passo 1 — acesso, cobrança, proteção dos dados e impressão

Implementação local em 13/11/2026. Este documento acompanha a revisão inicial em `REVISAO_OPERACIONAL.md`.

## Entregas

- Usuários individuais, senha protegida por scrypt, sessões de oito horas em cookie HttpOnly e proteção CSRF nas alterações.
- Primeiro administrador criado com código exclusivo, sem usuário ou senha padrão. Depois da configuração, o primeiro cadastro é bloqueado.
- Perfis de operador, supervisor, financeiro e administrador. As permissões são verificadas pela API e refletidas na interface.
- Cadastro, alteração, desativação e troca de senha; revogação de sessões; proteção contra remover o último administrador ativo. Falhas repetidas de login são limitadas sem consumir a cota com logins corretos.
- Encerramento da sessão com remoção de cache, documentos, formulários e valores operacionais do navegador. Respostas de uma sessão encerrada são descartadas.
- Cotação de saída calculada pelo servidor, com validade de dois minutos. A tarifa vigente fica preservada na entrada, inclusive para reimpressão.
- Validação integral dos meios e valores de pagamento. Baixa, parcelas, recibo e auditoria pertencem à mesma transação. Repetir a mesma confirmação devolve o mesmo resultado sem duplicar o recebimento.
- Benefício mensalista validado no servidor pelo cadastro ativo e vencimento; recebimento pelo valor da tabela do servidor. Datas futuras e fim de mês são preservados corretamente na renovação.
- Entrada com verificação transacional de placa ativa e capacidade. Cancelamento restrito ao supervisor/administrador, com motivo obrigatório e ticket exato.
- Correção da renderização de textos livres no histórico, mensalidades, observações, meios de pagamento e comprovantes.
- Backup operacional completo, versionado e com verificação de integridade; restore exige perfil de administrador, senha e confirmação escrita. Arquivos inválidos são rejeitados, a substituição é transacional e as sequências são realinhadas. Usuários e credenciais são preservados.

## Perfis

| Perfil | Uso principal |
|---|---|
| Operador | Entrada, cotação, saída, recebimento de mensalidade e consulta operacional |
| Supervisor | Operação, administração de mensalistas, cancelamentos justificados e caixa |
| Financeiro | Consulta financeira e recebimento de mensalidades |
| Administrador | Todas as operações, tarifas, usuários e backup/restore |

A vinculação dos recebimentos ao turno, fundo inicial, sangrias, suprimentos, conferência e fechamento versionado foram implementados no [passo 2](PASSO_2_IMPLEMENTACAO.md).

## Comprovantes de 80 mm e 58 mm

Os três documentos possuem seletor de largura e preferência salva neste navegador. Usam fonte compacta, linhas curtas, altura da página calculada pelo conteúdo e áreas úteis conservadoras de 72 mm e 48 mm. Os campos vazios da empresa não ocupam linhas. O QR de entrada foi reduzido e validado pelo leitor real do navegador.

- **Entrada:** empresa, placa, veículo, cor, horário, tipo, tarifas, tolerância, QR, ticket legível e operador.
- **Saída:** empresa, placa, veículo, entrada, saída, permanência cobrada, categoria, instante do cálculo, total, meios e valores pagos, operação, ticket e operador.
- **Mensalidade:** empresa, placa, cliente, data do recebimento, meses pagos, vencimentos anterior/novo, total, meios e valores pagos, observação, operação e operador.

Os comprovantes novos são preservados no servidor. Saídas e mensalidades podem ser reimpressas pelo histórico com os dados originais. Registros antigos sem documento original não recebem um recibo reconstruído como se fosse o original.

| Documento | Modelo de 80 mm | Modelo de 58 mm |
|---|---|---|
| Entrada | [PDF](artifacts/comprovante-entrada-80mm.pdf) | [PDF](artifacts/comprovante-entrada-58mm.pdf) |
| Saída | [PDF](artifacts/comprovante-saida-80mm.pdf) | [PDF](artifacts/comprovante-saida-58mm.pdf) |
| Mensalidade | [PDF](artifacts/comprovante-mensalidade-80mm.pdf) | [PDF](artifacts/comprovante-mensalidade-58mm.pdf) |

Os seis exemplos ficaram em uma página e sem transbordamento horizontal no Edge. O conteúdo dos exemplos mediu aproximadamente 61 a 95 mm de altura; o documento acrescenta uma pequena folga de página. Esses valores variam com endereço, nome, observações e quantidade de meios de pagamento. PDFs e imagens de teste ficam em `artifacts/`, ignorado pelo Git.

Na impressora, selecione a mesma largura escolhida no sistema, escala de 100% e desative cabeçalhos/rodapés do navegador. O acionamento do corte e o avanço mecânico dependem da impressora/driver; não houve teste físico do equipamento.

## Ativar pela hospedagem — GitHub e Vercel

O fluxo utilizado neste projeto é commit/push no GitHub e deploy no Vercel. Na hospedagem, não é necessário executar `npm start` manualmente nem procurar o código no terminal local.

1. No projeto do Vercel, em **Settings → Environment Variables**, configure para **Production**:
   - `DATABASE_URL`: mantenha a conexão do banco operacional existente.
   - `PGSSLMODE=require`, quando exigido pelo banco, como na configuração de Neon descrita no README.
   - `APP_TIMEZONE=America/Sao_Paulo`.
   - `AUTH_SETUP_TOKEN`: um código longo, aleatório e exclusivo para criar o primeiro administrador. Salve-o diretamente no painel; não inclua o valor no GitHub.
2. Faça commit e push de todos os arquivos novos e alterados da etapa, incluindo `backend/app.js`, rotas, serviços, `backend/migrations/001-security.sql`, scripts novos do frontend e `vercel.json`. Um commit somente dos arquivos já rastreados não inclui esses arquivos novos.
3. Faça o deploy pelo fluxo já conectado ao GitHub. Se as variáveis forem alteradas depois de um deploy, faça um novo deploy para que sejam utilizadas.
4. Abra o domínio HTTPS do sistema. Na tela **Primeiro acesso**, informe o mesmo `AUTH_SETUP_TOKEN` cadastrado no Vercel e crie seu administrador e senha.
5. Cadastre funcionários em **Configurações → Usuários e permissões** e preencha os dados do estacionamento para os comprovantes.

As sessões são persistidas no PostgreSQL, permitindo acesso entre instâncias da hospedagem. A configuração de build inclui explicitamente o schema e as migrações SQL no pacote da função. A preparação aditiva ocorre na primeira requisição que precisa do banco e registra sua versão para não repetir os comandos em cada instância. A implantação real e seus logs ainda precisam ser conferidos depois do push/deploy. Os testes locais não publicam as alterações na hospedagem.

Se usar deploy de Preview para testar, configure um banco separado para esse ambiente, pois a inicialização também aplica o schema/migração no banco indicado pelas variáveis daquele deploy.

Referências: [variáveis por ambiente no Vercel](https://vercel.com/docs/environment-variables/managing-environment-variables), [configuração do projeto](https://vercel.com/docs/project-configuration/vercel-json).

## Execução local opcional

1. Reinicie o backend com `npm start` dentro de `backend/`.
2. Abra o endereço informado pelo terminal. A migração aditiva `backend/migrations/001-security.sql` é aplicada no primeiro acesso à API, quando necessária, preservando os registros operacionais.
3. Se for o primeiro acesso, use o código mostrado no terminal para criar seu administrador e senha. Em hospedagem, configure `AUTH_SETUP_TOKEN` antes do primeiro acesso; o código local aleatório não é usado em produção.
4. Cadastre funcionários em **Configurações → Usuários e permissões** e preencha os dados do estacionamento para os comprovantes.

Não há credencial administrativa padrão ou conta de teste no sistema real. As credenciais fixas existentes nos arquivos de teste são criadas exclusivamente no banco isolado em memória. Os testes não executam a migração no banco operacional nem publicam a alteração na hospedagem.

## Validação

Resultado final: **33 testes de lógica/API aprovados e 12 testes de navegador aprovados**. Os seis PDFs foram gerados em uma página cada, sem transbordamento horizontal, e o QR reduzido da entrada foi decodificado pelo leitor real do navegador.

`npm test` valida a lógica e a API, incluindo um PostgreSQL isolado em memória por PGlite. A bateria cobre bootstrap único, autorização, CSRF, origens, senha, falhas/repetições de pagamento, renovação, rollback, backup/restore, sequências, bloqueio de login e revogação de sessões.

`npm run test:browser` valida a aplicação pelo Edge: placas/câmera, login/logout, perfis, transição do primeiro acesso, textos maliciosos e o fluxo completo de entrada → saída paga → mensalidade → seis impressões em PDF. Não usa o banco operacional nem fornecedores reais.

Para checar somente os comprovantes: `npm run test:browser -- --grep "comprovantes compactos"`.

## Próximas etapas

| Etapa | Estado |
|---|---|
| 1. Proteger acesso, cobrança e dados; compactar comprovantes | Implementada localmente; evidências e testes descritos acima |
| 2. Estruturar caixa e turnos | Implementada localmente; detalhes em PASSO_2_IMPLEMENTACAO.md |
| 3. Organizar contratos, mensalistas e relatórios | Aguardando autorização do usuário |
| 4. Consolidar operação, automações, recuperação e produtividade | Aguardando a conclusão do passo 3 |

Backup automático, recuperação das credenciais, política de manutenção na restauração, testes com banco da hospedagem, validação física da impressão e contingência continuam como atividades da consolidação operacional. O backup atual protege e recupera os dados operacionais; o arquivo não substitui a recuperação de usuários/senhas ou uma imagem integral da instância PostgreSQL.
