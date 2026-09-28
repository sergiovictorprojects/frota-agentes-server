# Baseline técnico — Fase 0

> Diagnóstico realizado em 2026-09-28 sobre o commit `7608af82d26af957ec7563cdd0ef1611e975ff4c` de `master`.
>
> Escopo: inspeção e validação. Nenhuma mudança de código, schema, configuração de produção ou comportamento foi feita nesta fase.

## Resultado executivo

O servidor atual é um MVP funcional e bem testado para processar uma fila de demandas com LLM, auditoria posterior, relatórios e entregas hospedadas. A base é apropriada para evoluir incrementalmente para a Frota de Agentes, mas ainda não implementa o modelo operacional auditável, o Policy Engine determinístico, o catálogo real de agentes, o dossiê por demanda nem a visualização em tempo real definidos na documentação.

A próxima alteração deve ser exclusivamente a **Fase 1 — Modelo Operacional Auditável**, começando pelo ledger de eventos aditivo. Não iniciar a cidade 3D ou ampliar a frota antes desse alicerce.

## Validações executadas

| Verificação | Resultado | Evidência |
|---|---:|---|
| Estado inicial do clone | OK | `master...origin/master`, sem mudanças locais antes das validações |
| TypeScript | OK | `npm run typecheck` concluiu sem erros |
| Testes | OK | `268/268` testes em `27` arquivos passaram |
| Cobertura | OK | Statements 97,77%; branches 89,76%; functions 96,50%; lines 99,06% |
| Migração/integração com PostgreSQL | Exercitada pela suíte | A suíte usa PostgreSQL embutido descartável |

Observação operacional: o PostgreSQL embutido não executa como `root`. Os testes passaram sob usuário sem privilégios. O CI/deploy de testes deverá manter execução não-root ou configurar explicitamente o mecanismo de banco efêmero; isto não é falha do produto em si, mas é requisito do ambiente de teste.

## Estado real confirmado

### Runtime e infraestrutura

- Node.js/TypeScript, Fastify, PostgreSQL, `pg-boss`, Anthropic SDK e Zod.
- Scheduler persistido no PostgreSQL, com fila `exclusive`, heartbeat e job cron configurável.
- Até três demandas por run por padrão; reivindicação atômica com `FOR UPDATE SKIP LOCKED`.
- Recuperação de demandas abandonadas, limite de três tentativas e pausa por orçamento mensal.
- Deploy preparado para Railway por Dockerfile, health check e restart policy.
- Não foi encontrado diretório `.github` no `master`; portanto, não há workflow de GitHub Actions versionado no repositório nesta data.

### Dados e fluxo

As tabelas principais atuais são:

- `demandas`: fila, estado, tentativa, claim, pendência e URL de entrega.
- `mensagens`: conversa com solicitante e checkpoints narrativos dos agentes.
- `runs`: execução cron/manual.
- `agent_steps`: papel, modelo, tokens, custo e duração de cada chamada LLM.
- `relatorios`, `aprendizado_evolucao` e `entregas`: resultado pós-execução.
- `system_flags`: pausa global e alertas de orçamento.

O processamento atual é: demanda nova → claim → chamada ao papel do setor → possível pendência humana/insumo → entrega hospedada → auditoria LLM → relatório/aprendizado → status final.

Os setores `gestores` e `d1`–`d18` são papéis estáticos em `src/domain/setores.ts`; eles não formam ainda um catálogo de agentes com identidade, capacidade, status, ferramenta, skill e versão próprios.

### Controles existentes que devem ser preservados

- Validação de entrada com Zod e SQL parametrizado.
- Limite de requisições, headers de segurança, CSP e verificação de origem para operações de escrita.
- Autenticação Basic para a interface.
- Entregas HTML isoladas em iframe sandbox, com CSP que bloqueia rede e armazenamento.
- Prompt injection tratado por delimitação/neutralização dos dados da demanda.
- Auditoria separada da execução, com evidência mínima e regras reconhecidas.
- Guardrail de custo com kill-switch e notificações.
- Fila concorrente, recuperação de claims abandonados e tratamento de erros sistêmicos.

## Divergências em relação à arquitetura-alvo

1. **Não há ledger de eventos.** `mensagens` e `agent_steps` são úteis, porém não capturam uma sequência tipada, versionada e imutável de eventos operacionais.
2. **Não há dossiê por demanda.** A tela atual mostra demanda, mensagens e o relatório mais recente; não reúne snapshot, timeline, políticas, evidências, artefatos e métricas em um caso auditável.
3. **Não há stream de operação.** Não existe SSE/WebSocket, cursor de replay, endpoint de eventos ou projeção para o modo “Em Operação”.
4. **A auditoria atual não é Policy Engine.** Ela é posterior, baseada em LLM e em regras por setor; não bloqueia transições com regras determinísticas, ações permitidas ou exigência formal de aprovação humana.
5. **Não há catálogo de agentes/skills.** Os setores são constantes de código e não há versionamento de conhecimento, fonte, licença, indexação, recuperação ou proveniência.
6. **Não há interface 3D ligada a fatos reais.** A visualização desejada deve consumir projeções do ledger, não estados inventados pela UI.
7. **Autorização ainda é de MVP.** Basic Auth e links UUID para entregas são aceitáveis como solução inicial controlada, mas não substituem RBAC, contas individuais, MFA para funções críticas, expiração/revogação de compartilhamentos e auditoria de acesso.
8. **O repositório está público.** A documentação recém-adicionada não contém segredos, mas a visibilidade precisa ser decidida conscientemente antes de incluir materiais internos, prompts proprietários, arquitetura sensível ou dados de clientes.

## Plano de migração recomendado para a Fase 1

1. Adicionar migration **somente aditiva** para `agent_events`, com `id`, `demanda_id`, `run_id`, sequência/cursor, tipo, ator, resumo operacional, metadados JSONB versionados, correlação, timestamps e índices de consulta.
2. Criar um `EventRecorder` e registrar eventos reais nos pontos já existentes: criação, claim, início/fim de execução, chamada LLM, pendência, entrega, auditoria, erro, retry, pausa e conclusão.
3. Preservar `mensagens`, `agent_steps`, `relatorios` e os estados atuais. O ledger será uma escrita adicional, não uma substituição nesta fase.
4. Implementar endpoint inicial de dossiê somente-leitura, agregando demanda, timeline, relatório, entrega e métricas existentes.
5. Criar testes de migration, ordenação, idempotência de evento, retry, ausência de segredos e ausência de raciocínio interno bruto.
6. Colocar a nova leitura sob feature flag ou rota nova; somente depois avaliar SSE e a projeção para visualização 3D.

## Estratégia de rollback

- Migrations aditivas e compatíveis com o schema atual.
- Dual-write pode ser desativado por feature flag sem interromper a fila.
- O runtime atual continua usando as tabelas e estados existentes.
- Não remover, renomear ou reinterpretar `mensagens` e `agent_steps` na Fase 1.
- Se a projeção do dossiê falhar, desabilitar a rota nova; eventos persistidos permanecem para diagnóstico.
- Toda alteração estrutural deve ter teste de upgrade em banco existente e plano de rollback documentado antes do merge.

## Riscos que devem orientar a implementação

- Eventos podem conter dados sensíveis: aplicar classificação, minimização, redaction e retenção desde a primeira migration.
- Não registrar chain-of-thought. Registrar decisões operacionais, evidências, entradas/saídas resumidas, regras aplicadas, versões e resultados verificáveis.
- Retries podem duplicar eventos: definir chave de idempotência e correlação por tentativa.
- “Concluída” não deve equivaler a “aprovada”: manter resultado de Policy Engine e aprovação humana como estados explícitos.
- Conhecimento externo só deve entrar com origem, licença, versão, data de ingestão e possibilidade de remoção.
- A ausência de workflow CI versionado aumenta o risco de regressão; introduzir CI obrigatório antes de mudanças de maior alcance.
- A configuração de proteção de branch não pôde ser lida pela integração utilizada; confirmar manualmente regras de merge, revisão e checks obrigatórios no GitHub.

## Próximo passo para o ambiente de desenvolvimento

Antes de editar, ler `CLAUDE.md` e os documentos em `docs/`. Em seguida, apresentar um plano de implementação da Fase 1 contendo arquivos afetados, SQL da migration aditiva, contrato do evento, testes, compatibilidade e rollback. Só implementar após aprovação explícita desse plano.

Consulte também:

- [Roadmap de implementação](IMPLEMENTATION_ROADMAP.md)
- [Taxonomia de eventos](EVENT_TAXONOMY.md)
- [Especificação do dossiê](DOSSIER_SPEC.md)
- [Políticas e segurança](POLICY_AND_SECURITY.md)
