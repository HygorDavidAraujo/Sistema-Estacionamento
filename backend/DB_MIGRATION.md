# Plano para migrar de SQLite para Postgres (Railway/Neon)

## Variáveis de ambiente
- `PORT` (fornecida pelo Railway)
- `DATABASE_URL` (URL Postgres completa)
- `PGSSLMODE` (`require` em cloud se obrigatório)
- `ANPR_URL` (endpoint OCR de placa) 
- `ANPR_API_KEY` (token do provider, se existir)
- `ANPR_FAKE_PLATE` (opcional para testes offline)

## Passos sugeridos
1) Criar base Postgres no provedor (Railway ou Neon) e anotar `DATABASE_URL`.
2) Rodar o schema inicial (`schema.sql`) na nova base.
3) Trocar o driver no backend de `sqlite3` para `pg`:
   - Criar um módulo `db.js` que exporta um `Pool` e helpers (`query`, `tx`).
   - Substituir no `server.js` as chamadas diretas ao SQLite pelos helpers.
   - Ajustar SQL para sintaxe Postgres (schema já está em formato compatível).
4) Conexões: usar `pg.Pool` com `max` baixo (5–10) para tiers free.
5) Logs/erros: manter mensagens amigáveis e status HTTP; logar `err.message` em caso de falha.
6) Testar fluxos completos: entrada (gera QR), saída por QR, histórico, caixa, configs.
7) Deploy: definir envs no Railway e redeployar.

## Notas de compatibilidade
- Campos de data/hora: usar `TIMESTAMP WITH TIME ZONE DEFAULT NOW()`.
- Auto-increment: `GENERATED ALWAYS AS IDENTITY` (ou `SERIAL`).
- Índices úteis: `entry_id` único, `placa`, `status`, `data_saida`, `forma_pagamento` para relatórios.
- Filtragem por data: considere armazenar `data_entrada`/`data_saida` como `DATE` e `hora_entrada`/`hora_saida` como `TIME` ou consolidar em um `TIMESTAMP` para simplificar queries futuras.

## Checklist rápido antes da migração
- [ ] Schema aplicado em Postgres
- [ ] Driver trocado para `pg` com pool
- [ ] Variáveis de ambiente configuradas
- [ ] OCR configurado (`ANPR_URL`/`ANPR_API_KEY`) ou `ANPR_FAKE_PLATE` para testes
- [ ] Testes manuais de entrada/saída/histórico/caixa
