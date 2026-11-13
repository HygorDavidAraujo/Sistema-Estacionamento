# Correção da indisponibilidade do banco no Vercel

Data: 13/11/2026.

## Diagnóstico confirmado

O deploy de produção `dpl_5ZuXVW3wWqNzcMfZhaDQEQ6VKHd3`, do commit `5b488f6`, respondeu 503 em `/api/auth/status`. A resposta foi reproduzida na hospedagem durante a investigação.

Os logs registraram `Connection terminated due to connection timeout` ao executar a primeira consulta de `initDb`. Também houve registros de `Schema aplicado com sucesso` em outras requisições do mesmo deploy. Portanto, o diagnóstico observado é falha de conexão durante a preparação do banco, e não ausência geral dos arquivos SQL. Não foi necessário ler ou alterar os valores secretos de conexão ou do código inicial.

O código anterior usava três segundos para conectar, disparava a preparação fora da requisição e guardava uma promessa que, depois da primeira falha, deixava a instância permanentemente marcada como indisponível. A mensagem 503 era produzida antes da validação do código de primeiro acesso.

## Correções

- Preparação do banco iniciada e aguardada pela requisição que precisa dele.
- Requisições simultâneas compartilham a preparação; falha permite nova tentativa com intervalo limitado.
- Prazo de conexão e consulta aumentado para 15 segundos, com opções de ajuste por ambiente.
- Integração oficial do pool PostgreSQL com a suspensão das funções do Vercel.
- Schema, compatibilidade e migração aplicados em uma transação, sob bloqueio entre instâncias.
- Versão registrada em `estacionamento_migracoes`. Instâncias seguintes verificam a versão e evitam repetir dezenas de comandos DDL.
- Compatibilidade das colunas existentes preparada antes dos índices, preservando os registros.
- Botão **Tentar novamente** na tela de acesso; o formulário só é liberado depois de conferir a disponibilidade e o estado do primeiro acesso.
- Diagnóstico de erro sem imprimir URL, senha ou parâmetros da conexão.

Referência do gerenciamento do pool: [API oficial de Functions do Vercel](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package).

## Validação

Resultado: **40 casos de lógica/API e 13 testes de navegador aprovados**. Inclui a importação da função com `VERCEL=1`, confirmando que a aplicação é exportada sem conectar ao banco nem iniciar migração fora da requisição.

Os testes usam PostgreSQL isolado em memória. Foram acrescentados casos para conexão falhando e recuperando na mesma instância, requisições simultâneas, preservação de dados legados, migração sem repetição e rollback integral após falha. Os testes da aplicação passam a usar o mesmo inicializador de schema usado em produção.

O teste de navegador simula 503 ao abrir o acesso e confirma recuperação por **Tentar novamente**, seguida de login e sincronização do pátio.

## Publicar a correção

Faça commit e push de todos os arquivos alterados e novos, incluindo `backend/package-lock.json`, os dois serviços novos de inicialização e `backend/migrations/000-compatibility.sql`, e realize o deploy pelo fluxo GitHub → Vercel.

Os valores de 15 segundos são padrão: não é necessário criar variáveis novas para usá-los. Se desejar um ajuste específico, os nomes são `PG_CONNECTION_TIMEOUT_MS` e `PG_QUERY_TIMEOUT_MS`.

Esta correção foi preparada localmente. O deploy de produção identificado acima permanece com o código anterior até a publicação. Depois do novo deploy, confira `/api/auth/status`, crie o primeiro administrador se ainda não existir e valide o login pelo domínio do sistema.

Mensagem sugerida de commit: `Corrige timeout e recuperação da conexão PostgreSQL no Vercel`.
