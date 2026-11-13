# Passo 4 — operação e recuperação

Implementação local concluída em 13/11/2026. Os quatro passos estão implementados. A pedido do responsável, o funcionamento padrão usa **backup manual, sem conectar Vercel Blob ou contratar armazenamento adicional**. Publique as alterações pelo fluxo GitHub → Vercel.

## O que foi implementado

- **Painel administrativo:** Configurações → Operação, backup e recuperação reúne disponibilidade do banco, versão da migração, pátio, diferenças de caixa, manutenção e data da última geração manual. Sem armazenamento conectado, informa modo manual e não apresenta configuração de nuvem como pendência.
- **Backup manual operacional:** download dos dados operacionais no formato v3, sem usuários/senhas, disponível sem configurar novas variáveis.
- **Backup manual completo cifrado:** download direto para o computador de pacote com AES-256-GCM, compactação, checksum, usuários com hashes de senha e dados operacionais. Não inclui sessões. É decifrado e validado em memória antes da resposta; não usa Blob nem salva arquivo na hospedagem. Requer somente `BACKUP_ENCRYPTION_KEY`.
- **Rotina manual:** não há cópia automática nem retenção de arquivos baixados pelo aplicativo. O responsável deve baixar, conferir e guardar uma cópia ao final de cada expediente. A data no painel registra a geração, sem garantir que o navegador terminou de salvar o arquivo.
- **Restauração:** pré-validação no servidor, manutenção obrigatória, senha do administrador e confirmação `RESTAURAR`. Guarda automaticamente uma cópia operacional anterior na mesma transação. Uma falha desfaz a substituição; após sucesso, mantém manutenção e revoga as demais sessões.
- **Recuperação de acesso:** código administrativo de uso único permite trocar a senha de um administrador ativo existente. O código não cria usuários. As sessões desse administrador são revogadas.
- **Recuperação integral:** ferramenta local restaura dados e usuários em outra base vazia, sem importar sessões. A base recuperada começa em manutenção.
- **Falhas de conexão:** aviso visível de disponibilidade e conferência de confirmações financeiras cuja resposta não chegou ao navegador. A consulta recupera o resultado já gravado; um reenvio conserva a referência original para impedir recebimento duplicado.
- **Produtividade:** F2 entrada, F4 saída, F6 mensalistas e F8 turno. Os atalhos respeitam a sessão, os controles disponíveis e os formulários abertos.
- **Diagnóstico:** `/api/health` verifica o processo; `/api/ready` consulta o banco. Respostas possuem `X-Request-ID`; falhas do servidor registram essa referência nos logs. A conexão PostgreSQL verifica certificado e nome do servidor mesmo quando a URL contém `sslmode=require`.

## Publicar sem armazenamento adicional

1. O backup operacional funciona com as variáveis existentes. Para habilitar também a cópia completa cifrada e a recuperação de senha, no seu computador, dentro de `backend/`, instale as dependências e gere os dois segredos opcionais:

   ```powershell
   npm install
   npm run setup:secrets
   ```

   O comando imprime dois valores aleatórios independentes: `BACKUP_ENCRYPTION_KEY` e `AUTH_RECOVERY_TOKEN`. Copie cada valor para a variável de mesmo nome em **Vercel → projeto → Settings → Environment Variables → Production**. A primeira habilita o arquivo completo cifrado; a segunda, a troca de senha de administrador com código de uso único. Guarde os valores em um gerenciador seguro; nunca no GitHub ou em mensagens de suporte. Nenhum segredo real foi criado ou salvo nesta implementação.

2. **Não precisa conectar Blob nem configurar `BLOB_STORE_ID`, `BLOB_READ_WRITE_TOKEN` ou `CRON_SECRET`.** O agendamento foi removido do `vercel.json`; as cópias automáticas ficam desativadas por padrão. A compatibilidade com armazenamento externo existente foi preservada no código, mas não cria recursos nem é usada pelo download manual.

3. Preserve `DATABASE_URL`, `AUTH_SETUP_TOKEN`, fuso e demais variáveis existentes. Não configure `RECOVERY_DATABASE_URL` nem `RECOVERY_CONFIRM` no Vercel: são exclusivas da recuperação manual em outro banco. Caso a variável `BACKUP_AUTOMATIC_ENABLED` já exista, deixe-a como `false`.

4. Faça commit/push **de todos os arquivos novos e alterados**, incluindo `backend/migrations/005-operational-recovery.sql`, novos serviços, rotas, scripts, frontend, `package.json`, `package-lock.json` e `vercel.json`. A migração é aplicada automaticamente na primeira requisição que precisa do banco. **Não precisa executar SQL no editor do Neon.** Faça novo deploy depois de configurar variáveis.

5. Entre como administrador e abra **Configurações → Operação, backup e recuperação**. Use **Baixar backup operacional**, confira o download e guarde o arquivo fora da hospedagem. Com a chave configurada, use também **Baixar backup completo cifrado** e teste a verificação local descrita no [guia de recuperação](GUIA_OPERACAO_E_RECUPERACAO.md).

6. Estabeleça uma rotina de download ao final do expediente, preservando várias datas e uma cópia em outro dispositivo ou local seguro. Sem uma cópia baixada, a perda do banco não é coberta pelo modo manual. Os pontos de retorno no próprio banco não substituem esse arquivo.

Esta adaptação não contrata serviços adicionais de armazenamento e não agenda chamadas automáticas. A aplicação continua usando a hospedagem e o banco existentes, sujeitos aos limites da sua conta. A função possui duração configurada de até 60 segundos; limites efetivos dependem da hospedagem. [Duração de funções](https://vercel.com/docs/functions/configuring-functions/duration).

## Arquivos e credenciais

O **backup operacional v3**, disponível no fluxo anterior, continua sem usuários/senhas. As versões 1 e 2 continuam compatíveis. O **pacote de recuperação cifrado v1** contém o operacional v3, usuários com hashes de senha e referências dos códigos de recuperação já consumidos. Nenhum dos dois inclui sessões.

Restaurar um arquivo operacional pela interface conserva as credenciais atuais. Para extrair o operacional do arquivo cifrado ou recuperar também os usuários em outra base vazia, use a ferramenta local descrita no guia. Não é uma imagem física de toda a instância PostgreSQL: catálogo de backups, pontos de retorno e demais tabelas de controle não são importados pela recuperação integral.

Guarde a chave de cifragem fora do banco e fora do projeto. Sem ela, os arquivos cifrados não podem ser recuperados. Ao trocar a chave, preserve as anteriores para suas respectivas cópias; os botões da aplicação usam a chave atual. As cópias baixadas e as chaves precisam de acesso restrito.

## Conferência antes de liberar o atendimento

O [GUIA_OPERACAO_E_RECUPERACAO.md](GUIA_OPERACAO_E_RECUPERACAO.md) descreve indisponibilidade, resultado de pagamento desconhecido, restauração, retorno à cópia anterior e recuperação de administrador/banco. Após restaurar, confira pátio físico, turno, recebimentos, mensalistas e diferenças com os comprovantes do período. A aplicação mantém o atendimento suspenso até o administrador liberar com justificativa.

Os pontos de retorno guardam as três restaurações mais recentes **no mesmo banco**; não substituem arquivos baixados e guardados fora dele. O formato operacional importado pela interface tem limite de 10 MB na aplicação, sujeito também aos limites de requisição da hospedagem. Os pacotes cifrados têm limite de 64 MiB de conteúdo descompactado e 96 MiB de arquivo; os limites de resposta, tempo e memória da hospedagem podem reduzir o tamanho prático dos downloads.

## Validação e limites

- `npm test`: **87 testes de lógica/API aprovados**, sem falhas.
- `npm run test:browser`: **21 testes de navegador aprovados**, sem falhas. Inclui recuperação completa sem Blob e download dos dois arquivos pela interface.
- `npm audit`: **zero vulnerabilidades reportadas**. O SDK Blob foi fixado em `2.9.0`; o override de Zod em `@vercel/cli-config` evita a versão vulnerável da dependência transitiva.
- Os testes incluem concorrência de backup, falha na leitura externa, cifragem adulterada, chave incorreta, repetição do agendamento, manutenção, rollback de restauração, recuperação em segunda base vazia com usuários/recebimentos, código administrativo de uso único e pagamento gravado cuja resposta se perdeu.
- PostgreSQL isolado por PGlite. O fluxo manual foi testado sem armazenamento conectado e sem chamadas de upload, leitura ou remoção de arquivo externo. Os testes antigos de compatibilidade usam armazenamento simulado. Não foram acessados Neon/Blob de produção, executados commit/push/deploy ou alteradas variáveis da sua conta. Confira o download real após publicar.
- Os comprovantes compactos de 58 mm e 80 mm continuam cobertos pelos testes de navegador. Impressão física, equipamento de cancela e disponibilidade de rede não foram validados em campo. Pagamentos informados pelo operador não possuem conciliação automática com banco/Pix ou adquirente.
