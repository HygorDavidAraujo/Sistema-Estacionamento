# Sistema de Estacionamento

Sistema completo para gerenciamento de estacionamento com consulta de veículos e controle de entrada/saída.

## 🚀 Funcionalidades

- **Consulta de Veículos**: Integração com API gratuita para buscar marca, modelo e cor por placa
- **Controle de Entrada/Saída**: Registro completo com horários e cálculo automático de permanência
- **Histórico Completo**: Filtros por dia, mês, ano e placa
- **Banco de Dados Postgres (Neon)**: Armazenamento persistente de todas as operações
- **Configurações Persistentes**: Valores de hora inicial, adicional e tolerância armazenados no banco
- **Validação de Placas**: Suporte para formato Mercosul (AAA1A23) e antigo (AAA1234)
- **Cálculo Automático**: Valor devido atualizado a cada 10 segundos

## 📋 Pré-requisitos

- Node.js (versão 18 ou superior)
- npm ou yarn
- Postgres (local ou Neon)

## 🔧 Instalação

1. Clone o repositório
```bash
git clone [URL_DO_REPOSITORIO]
cd "Sistema Estacionamento"
```

2. Instale as dependências do backend
```bash
cd backend
npm install
```

## ▶️ Como Executar

1. Configure as variáveis de ambiente (copie `.env.example` para `.env`)
```bash
DATABASE_URL=postgres://user:password@host:5432/database
ANPR_FAKE_PLATE=ABC1D23  # Para testes (ou configure ANPR_URL para OCR real)
```

2. Inicie o servidor backend
```bash
cd backend
node server.js
```

3. Abra o arquivo `index.html` no navegador ou use um servidor local

O servidor rodará na porta 3000 (ou próxima disponível 3001-3005)

### 📸 Configurando Reconhecimento de Placas (OBRIGATÓRIO para funcionar)

Para reconhecer placas reais com a câmera, você precisa configurar um serviço de OCR/ANPR:

#### Opção Recomendada: Plate Recognizer (2500 requisições/mês grátis)

1. Crie uma conta em: https://platerecognizer.com/
2. Copie sua API Key no dashboard
3. Configure no Vercel (Settings > Environment Variables):
   - `ANPR_URL` = `https://api.platerecognizer.com/v1/plate-reader/`
   - `ANPR_API_KEY` = `sua_chave_da_api`
4. Faça redeploy do projeto

#### Alternativas:
- **OpenALPR Cloud**: https://www.openalpr.com/cloud-api.html
- **Sighthound**: https://www.sighthound.com/products/cloud

#### Formato esperado da resposta:
```json
{
  "results": [
    {
      "plate": "ABC1D23",
      "confidence": 0.95
    }
  ]
}
```

**Nota**: Sem configurar `ANPR_URL`, o reconhecimento automático não funcionará. O OCR local (Tesseract.js) foi desativado no mobile por baixa performance.

## 🏗️ Estrutura do Projeto

```
Sistema Estacionamento/
├── backend/
│   ├── server.js           # Servidor Express com rotas da API
│   ├── db.js               # Conexão com Postgres + bootstrap do schema
│   ├── schema.sql          # Schema Postgres (tabelas + seeds)
│   └── package.json        # Dependências do backend
├── frontend/
│   ├── script.js          # Lógica do cliente
│   └── style.css          # Estilos da aplicação
├── index.html             # Interface principal
├── .gitignore            # Arquivos ignorados pelo Git
└── README.md             # Documentação
```

## 🛠️ Tecnologias Utilizadas

### Backend
- **Node.js** com **Express.js**
- **Postgres** (Neon) via **pg**
- **node-fetch** para integração com API externa
- **CORS** para permitir requisições cross-origin

### Frontend
- **HTML5** semântico
- **CSS3** puro (sem frameworks)
- **JavaScript** vanilla (ES6+)

### API Externa
- **apicarros.com** - Consulta gratuita de veículos por placa

## 📊 Endpoints da API

### Veículos
- `GET /placa/:placa` - Consulta dados do veículo
- `POST /entrada` - Registra entrada de veículo
- `POST /saida` - Registra saída e calcula valor

### Histórico
- `GET /historico` - Lista histórico com filtros (dia, mes, ano)
- `GET /historico/:placa` - Busca por placa específica
- `GET /relatorio/resumo` - Estatísticas gerais

### Configurações ⚙️
- `GET /configuracoes` - Lista todas as configurações
- `GET /configuracoes/:chave` - Obtém configuração específica
- `PUT /configuracoes` - Atualiza múltiplas configurações

## 💾 Banco de Dados

### Tabela `historico`:
- `id` - Identificador único
- `placa` - Placa do veículo (normalizada para maiúsculas)
- `marca` - Marca do veículo
- `modelo` - Modelo do veículo
- `cor` - Cor do veículo
- `data_entrada` - Data de entrada (DATE)
- `hora_entrada` - Hora de entrada (TIME)
- `data_saida` - Data de saída (DATE)
- `hora_saida` - Hora de saída (TIME)
- `tempo_permanencia` - Tempo total no formato legível
- `valor_pago` - Valor pago pelo cliente
- `status` - "ativo" ou "saído"
- `criado_em` - Timestamp de criação

### Tabela `configuracoes`:
- `id` - Identificador único
- `chave` - Nome da configuração (única)
- `valor` - Valor da configuração
- `descricao` - Descrição da configuração
- `atualizado_em` - Data/hora da última atualização

**Configurações padrão:**
- `valor_hora_inicial`: R$ 5,00 (primeira hora)
- `valor_hora_adicional`: R$ 2,50 (hora adicional)
- `tempo_tolerancia`: 15 minutos

## 🎯 Regras de Negócio

- **Tarifa**: R$ 5,00 primeira hora + R$ 2,50 por hora adicional
- **Tempo Mínimo**: Primeira hora é cobrada integralmente
- **Normalização**: Placas sempre salvas em MAIÚSCULAS
- **Validação**: Aceita apenas formatos válidos de placa brasileira

## 🔄 Atualização em Tempo Real

O sistema atualiza automaticamente:
- Listagem de veículos no pátio a cada 10 segundos
- Cálculo do valor devido baseado no tempo de permanência
- Status visual dos veículos no pátio

## 📝 Licença

Este projeto é de código aberto para fins educacionais.

## 👤 Autor

Desenvolvido para gerenciamento eficiente de estacionamentos.

## 🚀 Deploy (Vercel + Neon)

1) Crie um banco no Neon e copie a `DATABASE_URL`.
2) Aplique o schema no Neon usando o arquivo `backend/schema.sql`.
3) No projeto do backend no Vercel, configure as variáveis:
	- `DATABASE_URL`
	- `PGSSLMODE=require`
	- (opcional) `ANPR_URL`, `ANPR_API_KEY`, `ANPR_FAKE_PLATE`
4) Suba o repositório no Vercel. O frontend é estático e o backend é servido em `/api`.

## 🐛 Problemas Conhecidos

Se o banco de dados apresentar erros, confira a `DATABASE_URL` e o acesso ao Neon.

## 🤝 Contribuindo

Contribuições são bem-vindas! Sinta-se à vontade para abrir issues ou pull requests.
