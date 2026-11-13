c# Passo 4 — operação, automações e recuperação

Implementação local concluída em 13/11/2026. Os quatro passos estão implementados. A ativação do armazenamento e do agendamento em produção depende da configuração abaixo e do deploy pelo seu fluxo GitHub → Vercel.

## O que foi implementado

- **Painel administrativo:** Configurações → Operação, backup e recuperação reúne disponibilidade do banco, versão da migração, pátio, diferenças de caixa, manutenção e histórico das cópias externas. Alerta quando não encontra cópia verificada nas últimas 36 horas.
- **Backup externo:** pacote cifrado com AES-256-GCM, compactação, checksum, usuários com hashes de senha e dados operacionais. Não inclui sessões. Cada arquivo é relido do armazenamento privado, decifrado e validado antes de ser anunciado como concluído. Uma trava no banco impede execuções simultâneas; a referência diária evita duplicação pelo agendamento.
- **Retenção:** padrão de 30 dias, configurável entre 7 e 365, preservando ao menos as três cópias verificadas mais recentes. A remoção só começa depois de verificar uma nova cópia. Uma falha de cópia ou retenção fica registrada; não é apresentada como proteção concluída.
- **Restauração:** pré-validação no servidor, manutenção obrigatória, senha do administrador e confirmação `RESTAURAR`. Guarda automaticamente uma cópia operacional anterior na mesma transação. Uma falha desfaz a substituição; após sucesso, mantém manutenção e revoga as demais sessões.
- **Recuperação de acesso:** código administrativo de uso único permite trocar a senha de um administrador ativo existente. O código não cria usuários. As sessões desse administrador são revogadas.
- **Recuperação integral:** ferramenta local restaura dados e usuários em outra base vazia, sem importar sessões. A base recuperada começa em manutenção.
- **Falhas de conexão:** aviso visível de disponibilidade e conferência de confirmações financeiras cuja resposta não chegou ao navegador. A consulta recupera o resultado já gravado; um reenvio conserva a referência original para impedir recebimento duplicado.
- **Produtividade:** F2 entrada, F4 saída, F6 mensalistas e F8 turno. Os atalhos respeitam a sessão, os controles disponíveis e os formulários abertos.
- **Diagnóstico:** `/api/health` verifica o processo; `/api/ready` consulta o banco. Respostas possuem `X-Request-ID`; falhas do servidor registram essa referência nos logs. A conexão PostgreSQL verifica certificado e nome do servidor mesmo quando a URL contém `sslmode=require`.

## Ativar no Vercel

1. No seu computador, dentro de `backend/`, instale as dependências e gere os segredos:

   ```powershell
   npm install
   npm run setup:secrets
   ```

   O comando imprime três valores aleatórios independentes: `BACKUP_ENCRYPTION_KEY`, `CRON_SECRET` e `AUTH_RECOVERY_TOKEN`. Copie cada valor para a variável de mesmo nome em **Vercel → projeto → Settings → Environment Variables → Production**. Guarde os valores em um gerenciador seguro; nunca no GitHub ou em mensagens de suporte. Esse comando deve ser executado por você; nenhum segredo real foi criado ou salvo nesta implementação.

2. Conecte ao projeto um **Vercel Blob privado**. A integração usa `BLOB_STORE_ID` com a identidade do ambiente Vercel; também aceita `BLOB_READ_WRITE_TOKEN` como alternativa de credencial. O backend usa o SDK oficial com `access: 'private'`. Escolha armazenamento privado ao criar o recurso e confira o ambiente associado. Consulte os limites e custos aplicáveis à sua conta. [Armazenamento privado](https://vercel.com/docs/vercel-blob/private-storage), [SDK e autenticação](https://vercel.com/docs/vercel-blob/using-blob-sdk).

3. Preserve `DATABASE_URL`, `AUTH_SETUP_TOKEN`, fuso e demais variáveis existentes. Não configure `RECOVERY_DATABASE_URL` nem `RECOVERY_CONFIRM` no Vercel: são exclusivas da recuperação manual em outro banco. Opções adicionais:

   | Variável | Padrão / finalidade |
   |---|---|
   | `BACKUP_RETENTION_DAYS` | `30`; retenção entre 7 e 365 dias, preservando ao menos três cópias |
   | `BACKUP_AUTOMATIC_ENABLED` | Ativo quando armazenamento, chave e segredo de agendamento estão configurados; `false` desativa apenas as cópias automáticas |

4. Faça commit/push **de todos os arquivos novos e alterados**, incluindo `backend/migrations/005-operational-recovery.sql`, novos serviços, rotas, scripts, frontend, `package.json`, `package-lock.json` e `vercel.json`. A migração é aplicada automaticamente na primeira requisição que precisa do banco. **Não precisa executar SQL no editor do Neon.** Faça novo deploy depois de configurar variáveis ou conectar o armazenamento.

5. Entre como administrador e abra **Configurações → Operação, backup e recuperação**. Confira armazenamento e chave, gere um backup manual e aguarde a indicação de verificado. Baixe o arquivo cifrado e teste a verificação local descrita no [guia de recuperação](GUIA_OPERACAO_E_RECUPERACAO.md). Só considere a proteção externa ativada após esse resultado.

6. Confira no Vercel a execução diária e, no painel, a próxima cópia verificada. O `vercel.json` solicita `/api/internal/manutencao` às **06:00 UTC** (03:00 em São Paulo na data desta implementação). O endpoint exige `CRON_SECRET` e recusa previews Vercel. O horário é uma programação, sem garantia de execução no minuto exato. [Agendamento e autenticação](https://vercel.com/docs/schedules/cron-jobs/manage-cron-jobs).

O agendamento também remove sessões e cotações expiradas e cache de veículos expirado há mais de 30 dias. Não apaga histórico, pagamentos ou auditoria. Durante manutenção, adia a cópia automática. A função possui duração configurada de até 60 segundos; limites efetivos dependem da hospedagem. [Duração de funções](https://vercel.com/docs/functions/configuring-functions/duration).

## Arquivos e credenciais

O **backup operacional v3**, disponível no fluxo anterior, continua sem usuários/senhas. As versões 1 e 2 continuam compatíveis. O **pacote de recuperação cifrado v1** contém o operacional v3, usuários com hashes de senha e referências dos códigos de recuperação já consumidos. Nenhum dos dois inclui sessões.

Restaurar uma cópia externa pela interface recupera somente sua parte operacional e conserva as credenciais atuais. Recuperar usuários também requer a ferramenta local e outra base vazia. Não é uma imagem física de toda a instância PostgreSQL: catálogo de backups, pontos de retorno e demais tabelas de controle não são importados pela recuperação integral.

Guarde a chave de cifragem fora do banco e fora do projeto. Sem ela, os arquivos cifrados não podem ser recuperados. Ao trocar a chave, preserve as anteriores para suas respectivas cópias; os botões da aplicação usam a chave atual. As cópias baixadas e as chaves precisam de acesso restrito.

## Conferência antes de liberar o atendimento

O [GUIA_OPERACAO_E_RECUPERACAO.md](GUIA_OPERACAO_E_RECUPERACAO.md) descreve indisponibilidade, resultado de pagamento desconhecido, restauração, retorno à cópia anterior e recuperação de administrador/banco. Após restaurar, confira pátio físico, turno, recebimentos, mensalistas e diferenças com os comprovantes do período. A aplicação mantém o atendimento suspenso até o administrador liberar com justificativa.

Os pontos de retorno guardam as três restaurações mais recentes **no mesmo banco**; não substituem as cópias externas. O formato operacional importado pela interface tem limite de 10 MB na aplicação, sujeito também aos limites de requisição da hospedagem. Os pacotes cifrados têm limite de 64 MiB de conteúdo descompactado e 96 MiB de arquivo; a restauração pelo identificador externo evita enviar esse arquivo no corpo da requisição. Tempo de execução e memória também limitam o tamanho prático atendido.

## Validação e limites

- `npm test`: **86 testes aprovados**, sem falhas.
- `npm run test:browser`: **20 testes aprovados**, sem falhas, usando Edge.
- `npm audit`: **zero vulnerabilidades reportadas**. O SDK Blob foi fixado em `2.9.0`; o override de Zod em `@vercel/cli-config` evita a versão vulnerável da dependência transitiva.
- Os testes incluem concorrência de backup, falha na leitura externa, cifragem adulterada, chave incorreta, repetição do agendamento, manutenção, rollback de restauração, recuperação em segunda base vazia com usuários/recebimentos, código administrativo de uso único e pagamento gravado cuja resposta se perdeu.
- PostgreSQL isolado por PGlite e armazenamento externo simulado. Não foram acessados Neon/Blob de produção, executados commit/push/deploy ou alteradas variáveis da sua conta. A ativação e o teste da cópia real em produção continuam sob os passos acima.
- Os comprovantes compactos de 58 mm e 80 mm continuam cobertos pelos testes de navegador. Impressão física, equipamento de cancela e disponibilidade de rede não foram validados em campo. Pagamentos informados pelo operador não possuem conciliação automática com banco/Pix ou adquirente.
