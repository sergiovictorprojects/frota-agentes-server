# ADR 0008 — Motor sequencial inerte e capacidades de artefatos

## Status

Implementado na continuação da 3.2b-1, em 2026-09-29. A configuração pública ainda aceita apenas
`desligada` e `planejar`; portanto, o motor não entra no fluxo de produção por configuração.

## Decisão

1. O motor interno (`src/orchestrator/execucao-tarefas.ts`) cria o envelope, reserva o planejamento, registra e
   ativa o plano na mesma transação curta, reivindica tarefas específicas depois de montar o prompt e executa as
   tarefas estritamente em série.
2. A chamada ao modelo ocorre fora de qualquer transação. Claims e registros de envio usam lease/token; a
   persistência do artefato e da entrega depende do token atual.
3. O caminho com envelope usa `LlmComOrcamento.gerarComReserva`. O caminho legado continua usando `gerar`, para
   que uma chamada nunca seja registrada duas vezes em `agent_steps`. Timeout retém a reserva e permite liquidação
   tardia do uso, mas não autoriza persistir resultado com lease vencido.
4. O prompt de tarefa usa a serialização canônica e a redução determinística de contexto já existente. Nenhum
   prompt, resposta bruta, raciocínio, objetivo ou segredo entra no ledger.
5. Especialistas produzem apenas artefatos intermediários. A capacidade de publicar é exclusiva do coordenador;
   auditor e avaliador não produzem artefatos. Essas capacidades são um contrato explícito derivado do catálogo,
   sem alteração da migration 006.
6. A flag `executar`, a categoria piloto, a autorização administrativa, os scripts de rollback e a ligação ao
   fluxo público permanecem para a 3.2b-2. Nenhuma migration 007 foi criada nesta entrega.

## Rollback

O motor continua inacessível por ambiente. O rollback operacional é manter `ORQUESTRACAO_TAREFAS=desligada` ou
`planejar`; a migration 006 não é alterada e não há down migration.
