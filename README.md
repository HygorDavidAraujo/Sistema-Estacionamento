# Sistema de Estacionamento

Sistema completo para gerenciamento de estacionamento com consulta de veículos e controle de entrada/saída.

## 🚀 Funcionalidades

- **Consulta de Veículos**: Integração com API gratuita para buscar marca, modelo e cor por placa
- **Controle de Entrada/Saída**: Registro completo com horários e cálculo automático de permanência
- **Histórico Completo**: Filtros por dia, mês, ano e placa
- **Banco de Dados SQLite**: Armazenamento persistente de todas as operações
- **Validação de Placas**: Suporte para formato Mercosul (AAA1A23) e antigo (AAA1234)
- **Cálculo Automático**: Valor devido atualizado a cada 10 segundos

## 📋 Pré-requisitos

- Node.js (versão 14 ou superior)
- npm ou yarn

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

1. Inicie o servidor backend
```bash
cd backend
node server.js
```

2. Abra o arquivo `index.html` no navegador ou use um servidor local

O servidor rodará na porta 3000 (ou próxima disponível 3001-3005)

## 🏗️ Estrutura do Projeto

```
Sistema Estacionamento/
├── backend/
│   ├── server.js           # Servidor Express com rotas da API
│   ├── package.json        # Dependências do backend
│   └── estacionamento.db   # Banco de dados SQLite (gerado automaticamente)
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
- **SQLite3** para banco de dados
- **node-fetch** para integração com API externa
- **CORS** para permitir requisições cross-origin

### Frontend
- **HTML5** semântico
- **CSS3** puro (sem frameworks)
- **JavaScript** vanilla (ES6+)

### API Externa
- **apicarros.com** - Consulta gratuita de veículos por placa

## 📊 Endpoints da API

- `GET /placa/:placa` - Consulta dados do veículo
- `POST /entrada` - Registra entrada de veículo
- `POST /saida` - Registra saída e calcula valor
- `GET /historico` - Lista histórico com filtros (dia, mes, ano)
- `GET /historico/:placa` - Busca por placa específica
- `GET /relatorio/resumo` - Estatísticas gerais

## 💾 Banco de Dados

Tabela `historico`:
- `id` - Identificador único
- `placa` - Placa do veículo (normalizada para maiúsculas)
- `marca` - Marca do veículo
- `modelo` - Modelo do veículo
- `cor` - Cor do veículo
- `data_entrada` - Data de entrada (DD/MM/YYYY)
- `hora_entrada` - Hora de entrada (HH:MM:SS)
- `data_saida` - Data de saída (DD/MM/YYYY)
- `hora_saida` - Hora de saída (HH:MM:SS)
- `tempo_permanencia` - Tempo total no formato legível
- `valor_pago` - Valor pago pelo cliente
- `status` - "ativo" ou "saído"
- `criado_em` - Timestamp de criação

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

## 🐛 Problemas Conhecidos

Se o banco de dados apresentar erros, delete o arquivo `backend/estacionamento.db` e reinicie o servidor. Ele será recriado automaticamente.

## 🤝 Contribuindo

Contribuições são bem-vindas! Sinta-se à vontade para abrir issues ou pull requests.
