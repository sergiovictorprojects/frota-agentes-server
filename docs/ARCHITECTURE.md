# Arquitetura Atual e Arquitetura-Alvo

## Regra de leitura

Este documento distingue a arquitetura conhecida do repositório e a arquitetura-alvo. Antes de qualquer implementação, confirme o estado real do código.

## Arquitetura atual conhecida

O backend possui uma aplicação Fastify, PostgreSQL como banco principal, pg-boss para fila e workers de processamento, integração com modelo de linguagem, auditoria e UI HTTP.

Componentes identificados anteriormente:

| Área | Responsabilidade conhecida |
|---|---|
| src/db/migrations | Estrutura inicial de dados |
| src/domain/setores.ts | Categorias ou setores de atuação |
| src/orchestrator/processar-demanda.ts | Execução de uma demanda |
| src/orchestrator/processar-fila.ts | Consumo e coordenação da fila |
| src/orchestrator/prompts.ts | Construção e validação de prompts |
| src/orchestrator/auditoria.ts | Auditoria de resultado |
| src/http/app.ts | Aplicação HTTP, headers e health check |
| src/http/ui/rotas.ts | Rotas da interface |

Entidades conhecidas:

| Tabela | Papel provável |
|---|---|
| demandas | Estado e contexto da demanda |
| mensagens | Histórico operacional e interação |
| relatorios | Relatórios do processamento |
| aprendizado_evolucao | Registro inicial de aprendizado |
| runs | Tentativas ou execuções de uma demanda |
| agent_steps | Etapas de uma execução |
| entregas | Artefatos e resultados |
| system_flags | Pausas e controles globais |

## Arquitetura-alvo

~~~mermaid
flowchart LR
    U["Usuário autorizado"] --> W["Interface Web"]
    W --> A["API Fastify"]
    A --> P["PostgreSQL"]
    A --> Q["Fila pg-boss"]
    Q --> R["Workers"]
    R --> O["Orquestrador"]
    O --> G["Policy Engine"]
    O --> K["Catálogo de agentes"]
    O --> S["Skills e conhecimento"]
    O --> M["Modelo de IA e ferramentas"]
    R --> E["Eventos append-only"]
    E --> P
    P --> D["Dossiê e métricas"]
    P --> T["SSE e projeção de operação"]
    T --> W
    D --> W
    R --> X["Armazenamento de artefatos"]
~~~

## Separação de responsabilidades

### Banco transacional

PostgreSQL é a fonte de verdade para demandas, runs, etapas, eventos, políticas, relatórios, auditorias, dossiês e metadados de artefatos.

### Fila e workers

pg-boss agenda e distribui o trabalho. Um worker não representa um agente permanente; ele executa uma etapa em nome de um agente do catálogo.

### Orquestrador

Define o plano de trabalho, resolve dependências, seleciona agentes e skills, aplica limites de execução e consolida etapas.

### Policy Engine

Avalia regras determinísticas antes, durante e depois das ações. Ele não deve ser um simples prompt nem depender somente de um modelo de linguagem.

### Catálogo de agentes

Mantém identidade, estado, capacidade, permissões, limite de concorrência, skills, risco e coordenador de cada agente.

### Conhecimento

Mantém documentos, fontes, licenças, versões, skills e trechos recuperáveis. Grandes conteúdos não devem ser inseridos integralmente em prompts.

### Eventos e projeções

Eventos representam fatos operacionais persistidos. SSE e a cidade 3D consomem projeções desses eventos, sem alterar diretamente a execução.

### Artefatos

Arquivos grandes, anexos e entregas devem ficar em armazenamento de objetos. O banco armazena metadados, hash, classificação e referência controlada.

## Regras de dados

1. Cada demanda possui um identificador de correlação.
2. Cada run possui um identificador próprio.
3. Cada etapa possui tentativa, início, fim, resultado e contexto resumido.
4. Cada evento possui sequência dentro do run.
5. O evento é append-only; correções produzem um novo evento.
6. Dados grandes ou sensíveis não devem ser duplicados em eventos.
7. Todo artefato precisa de hash, classificação de acesso e política de retenção.
8. O dossiê final é um snapshot versionado, não uma consulta que muda silenciosamente.

## Arquitetura de nuvem recomendada

| Camada | Responsabilidade |
|---|---|
| Domínio e HTTPS | Endereço estável e comunicação segura |
| Serviço Web/API | UI, autenticação, endpoints e SSE |
| Worker | Processamento assíncrono e fila |
| PostgreSQL gerenciado | Dados transacionais e fila |
| Armazenamento de objetos | Anexos, entregas e artefatos |
| Observabilidade | Logs, métricas, tracing e alertas |
| Gerenciador de segredos | Chaves, tokens e credenciais |
| Backup e recuperação | Continuidade e restauração testada |

## Limites de acoplamento

- A UI não consulta tabelas internas diretamente.
- A cidade 3D não aciona agentes nem muda estados.
- O modelo não grava no banco sem passar por serviços validados.
- Ferramentas externas só podem ser chamadas após política e permissão.
- O Policy Engine não altera uma demanda sem registrar decisão e motivo.
- Dossiê e métricas são consumidores de eventos e registros operacionais.
