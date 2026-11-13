# Guia de operação e recuperação

Use este roteiro depois de ativar o passo 4 conforme [PASSO_4_IMPLEMENTACAO.md](PASSO_4_IMPLEMENTACAO.md). O painel fica em **Configurações → Operação, backup e recuperação**, disponível ao administrador.

## Rotina do responsável

No início do atendimento, confira acesso individual, turno do responsável e pátio. No painel administrativo, confira a data da última cópia externa verificada. Aviso de backup atrasado ou cópia com falha exige nova tentativa e investigação; não significa que os pagamentos foram perdidos.

Faça periodicamente o download de uma cópia cifrada para local seguro fora da hospedagem. Guarde a chave separadamente e ensaie a recuperação em outra base vazia. O teste de integridade do arquivo não substitui o ensaio de restauração.

Atalhos: **F2 entrada · F4 saída · F6 mensalistas · F8 turno**. A cobrança da diária, os períodos pré-pagos de 30 dias e a operação de um caixa por vez continuam com as regras dos passos anteriores.

## Internet ou banco indisponível

O aviso de conexão indica que o pátio exibido pode estar desatualizado. Suspenda novas confirmações pelo sistema e tente restabelecer a conexão. A aplicação depende do servidor para registrar entradas, saídas e pagamentos; não possui operação financeira offline.

Se for indispensável atender por procedimento manual, o responsável deve controlar separadamente horário, placa, valor, meio de pagamento e comprovante, conferindo depois com o histórico existente. O aplicativo não importa nem concilia automaticamente esses registros. Não recrie entradas ou pagamentos sem conferir o que já foi gravado.

Use **Atualizar conexão** após restabelecer a rede. Persistindo o erro, confira o deploy e os logs da função na Vercel e a disponibilidade do Neon. `/api/health` verifica o processo; `/api/ready` verifica também o banco. Forneça ao suporte a referência `X-Request-ID` da requisição com erro, sem enviar senhas ou URLs de conexão.

## Pagamento enviado, mas sem confirmação na tela

1. Não cobre novamente de imediato. Confira o aviso **Confirmações pendentes de conferência** e clique em **Consultar**.
2. Se o servidor já gravou a operação, o sistema recupera seu resultado e comprovante original sem repetir o recebimento.
3. Se não houver confirmação registrada, **Repetir mesma confirmação** reenvia os mesmos dados com a mesma referência. O servidor trata repetições sem duplicar recebimentos. Uma cotação expirada pode exigir conferir o atendimento e gerar nova cotação após confirmar que o pagamento não foi gravado.
4. Confira o pátio e o histórico antes de encerrar o atendimento.

A pendência fica no mesmo navegador durante a sessão e pode sobreviver ao recarregamento da página. Logout e encerramento da sessão limpam os dados locais por privacidade; nesse caso, consulte histórico, recibos e caixa no servidor. Não é fila offline e não reenvia pagamentos automaticamente.

## Restauração de dados operacionais

1. Avise a equipe e interrompa o atendimento. Anote os veículos presentes e a situação do caixa.
2. Gere e baixe uma cópia atual, quando possível. Escolha cuidadosamente data e origem do arquivo a restaurar: pagamentos posteriores à cópia escolhida não estarão nela.
3. Pelo painel, escolha **Restaurar dados operacionais** na cópia externa verificada; ou use o fluxo de importação do backup operacional e confira a prévia validada pelo servidor.
4. Informe justificativa, senha do administrador e digite `RESTAURAR`. A manutenção suspende alterações operacionais. Consultas de histórico, relatórios e pátio continuam disponíveis; detalhes de mensalista que precisem preparar cobranças podem ficar bloqueados.
5. A aplicação guarda um ponto de retorno, restaura em transação e encerra as outras sessões. Se ocorrer falha transacional, os dados anteriores permanecem. Se o retorno da requisição se perder, mantenha manutenção e confira o estado do painel antes de repetir.
6. Compare os dados restaurados com pátio físico, turno, conferências, recibos e mensalistas. O turno não é encerrado e os veículos não recebem saída automaticamente pela manutenção.
7. Somente após a conferência, informe o motivo no painel e libere a operação. Os demais operadores deverão entrar novamente.

Para voltar à situação imediatamente anterior, baixe **Cópia anterior** no painel e importe o arquivo operacional pelo mesmo procedimento. São conservados três pontos de retorno no banco; uma perda desse banco também perde esses pontos. Backups operacionais não restauram usuários; cópias externas restauradas pela interface também conservam os usuários e as senhas atuais.

## Recuperar senha do administrador

Na tela de acesso, use a opção de recuperação quando disponível. Informe o login de um **administrador ativo existente**, o valor de `AUTH_RECOVERY_TOKEN` guardado pelo responsável e a nova senha. O código é consumido uma única vez e as sessões anteriores desse usuário são revogadas. Depois, faça login com a nova senha.

Para uma futura recuperação, gere outro segredo e atualize `AUTH_RECOVERY_TOKEN` em Production, seguido de novo deploy. Não reutilize o segredo consumido. `AUTH_SETUP_TOKEN` serve somente para criar o primeiro administrador em banco sem usuários.

Se não souber o login ou não houver administrador ativo, não edite hashes de senha nem crie usuários diretamente no SQL: será necessário um procedimento assistido com acesso administrativo à hospedagem e conferência dos usuários.

## Verificar uma cópia cifrada no computador

Dentro de `backend/`, com dependências instaladas, forneça `BACKUP_ENCRYPTION_KEY` no ambiente local e execute:

```powershell
npm run recovery -- verificar "C:\Backups\backup-cifrado.json"
```

O comando verifica decifragem e estrutura e informa data e contagens sem imprimir usuários, hashes ou credenciais. Não conecta ao banco para essa ação.

Se precisar somente dos dados operacionais para importar pela interface:

```powershell
npm run recovery -- exportar-operacional "C:\Backups\backup-cifrado.json" "C:\Backups\operacional.json"
```

O arquivo de saída não pode existir previamente e não inclui credenciais. Proteja-o: seus dados operacionais ficam em texto legível. Uma chave antiga deve ser usada para as cópias cifradas com ela.

## Perda do banco: recuperar em outra base vazia

Este procedimento é manual e destinado ao responsável técnico. Use um banco separado. A ferramenta recusa destino com usuários ou dados operacionais; não existe opção de forçar substituição.

1. Baixe uma cópia cifrada do Blob privado ou use a cópia externa guardada. Se o banco foi perdido, o catálogo do painel também pode estar indisponível; os arquivos ficam no armazenamento privado, no prefixo `parking-backups/v1/`. Preserve sua chave de cifragem fora do banco.
2. Crie outra base PostgreSQL vazia no ambiente de recuperação. Não aponte o comando ao banco operacional.
3. No ambiente local de `backend/`, configure `BACKUP_ENCRYPTION_KEY`, `RECOVERY_DATABASE_URL` com a conexão da base vazia e `RECOVERY_CONFIRM=BANCO_VAZIO`. Preserve o `DATABASE_URL` original; a ferramenta usa a variável de recuperação e recusa sua igualdade literal com a conexão original. Não salve esses valores no Git.
4. Verifique o arquivo e execute:

   ```powershell
   npm run recovery -- restaurar-banco-vazio "C:\Backups\backup-cifrado.json"
   ```

5. A ferramenta prepara o schema, importa dados operacionais, usuários e códigos de recuperação já consumidos, sem sessões. A recuperação é transacional e inicia em manutenção.
6. Após sucesso, configure no Vercel `DATABASE_URL` com a nova conexão e faça novo deploy. Entre com uma conta e senha válidas na data da cópia; se necessário, use um **novo** código de recuperação para trocar a senha.
7. Confira todos os recebimentos posteriores à cópia e o estado físico do estacionamento antes de liberar. O arquivo não contém o catálogo das cópias nem pontos de retorno antigos. Gere uma nova cópia externa verificada depois da conferência.
8. Remova as variáveis locais de recuperação após o procedimento. Preserve o banco antigo para análise até encerrar a conferência.

O exercício automatizado foi realizado com uma segunda base isolada em memória. A recuperação do seu ambiente Neon/Vercel e a validação dos comprovantes na impressora física precisam ser ensaiadas pelo responsável no ambiente apropriado.
