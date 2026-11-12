# Modernização da consulta e da leitura de placas

Data: 12/11/2026.

## Entregas

- Consulta cadastral com FIPE API/Parallelum Alpha, retornando marca, modelo e cor quando disponíveis.
- Cache em PostgreSQL, independente do registro de entrada, e cache de memória com deduplicação de consultas simultâneas.
- Tratamento distinto de placa inválida, cadastro ausente, cota, credencial, timeout e resposta inválida.
- OCR Tesseract 5.1.1 no navegador, inclusive em dispositivos móveis, sem chave ou cobrança por leitura local.
- Câmera com enquadramento, recorte dos pixels originais, seleção local do melhor de três quadros e até três tentativas automáticas sequenciais.
- Confirmação dos sete caracteres antes de preencher a entrada; envio de foto e modo de placa de moto.
- Seleção de câmera, zoom e lanterna conforme suporte do dispositivo.
- Cancelamento por sessão, encerramento de streams e prevenção de respostas antigas no formulário.
- Formulário com mensagens de estado e atendimento manual quando não houver cadastro disponível.
- Interface responsiva atualizada e status de sincronização do pátio.
- Autenticação nas leituras operacionais e nas integrações; configuração obrigatória de token para acesso protegido em produção.
- Atualização de Express/Multer, correção da formatação de valores do histórico e escape de dados nos principais cartões/listagens.
- Servidor único para frontend/API e carregamento consistente do `.env` a partir da raiz ou de `backend/`.

## Validação

- Consulta real autorizada pelo usuário retornou Chevrolet Tracker, cinza, compatível com o veículo informado.
- A nova rota da aplicação retornou esses dados, reutilizou o cache na consulta seguinte e persistiu o cadastro no PostgreSQL. A persistência foi confirmada por leitura da tabela.
- Aplicação iniciada em `http://localhost:3000`; schema aplicado, configurações e pátio acessíveis.
- 21 testes automatizados de lógica/HTTP/aplicação passaram.
- 7 testes de navegador passaram, incluindo troca de placa, edição manual durante consulta, cota indisponível, encerramento da câmera e OCR real de imagem sintética.
- Auditoria de dependências após atualização: nenhuma vulnerabilidade conhecida reportada.

As imagens dos testes de interface estão em `artifacts/` e representam um ambiente de teste com dados simulados.

## Limites e configuração

A consulta gratuita é **Alpha e tem cota pequena**: 5 consultas mensais sem token ou 10 consultas bem-sucedidas com token gratuito, segundo a [documentação do fornecedor](https://fipe.api.br/docs/api/busca-por-placa-alpha). O cache evita nova consulta para veículos já salvos. Não houve ativação automática de serviço pago.

O OCR local baixa biblioteca/modelo na primeira leitura. A precisão em veículos reais depende de iluminação, distância, foco e enquadramento; os testes com vídeo e imagem sintéticos não medem a taxa de acerto no estacionamento. A câmera exige HTTPS ou localhost.

A nuvem é opcional e usa o contrato do Plate Recognizer quando `ANPR_API_KEY` estiver configurada. O sistema tenta primeiro o dispositivo e permite uma chamada de nuvem por captura sem resultado local.

As alterações estão no repositório local; não foi realizado novo deploy da hospedagem. Em produção, configure `ADMIN_TOKEN` e as variáveis do banco antes da publicação. Consulte `README.md` e os arquivos `.env.example`.

Esta entrega concentrou a modernização em consulta, captura e experiência operacional. O cálculo financeiro legado, as regras comerciais de cobrança e a recuperação completa de backups continuam exigindo uma evolução própria e homologação; os testes realizados não certificam esses fluxos.
