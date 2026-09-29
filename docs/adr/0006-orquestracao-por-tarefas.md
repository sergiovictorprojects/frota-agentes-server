# ADR 0006 — Orquestração Real por Tarefas (entrega 3.1: modo "planejar")

## Status

Entrega 3.1 implementada na branch `fase-3/planejamento-tarefas`. As entregas 3.2 (execução sequencial),
3.3 (concorrência) e 3.4 (dossiê) continuam só planejadas e exigem aprovação própria.

## Contexto

Hoje cada demanda é executada por uma única chamada ao agente do setor e auditada por uma segunda. A Fase 3
troca isso por um plano de tarefas: um coordenador propõe tarefas especialistas com dependências, e uma
tarefa de integração consolida o resultado numa entrega única. Antes de executar qualquer tarefa, é preciso
observar com dados reais se os planos propostos fazem sentido, quanto custam e com que frequência são
recusados. Essa observação é a entrega 3.1.

## Decisão

1. **Flag `ORQUESTRACAO_TAREFAS`**, com `desligada` (padrão) e `planejar`. Qualquer outro valor recusa o boot:
   não existe um modo que ligue algo que o código ainda não faz.
2. **Em `planejar`, o plano é só gravado.** Depois de `processamento_iniciado` e antes da execução legada,
   o coordenador (`frota:gestores`, papel `coordenador`) recebe a demanda dentro de `<demanda>` e devolve
   só chaves curtas, capacidades e dependências, sem texto livre. A demanda segue inteira pelo fluxo legado,
   com o mesmo resultado. Nenhuma tarefa é executada e não há paralelismo.
3. **O planejador recebe o mesmo contexto que o executor legado.** `processarDemanda` carrega a conversa da
   demanda (o pedido da frota e a resposta do solicitante) uma única vez e passa a mesma lista ao prompt do
   planejador e ao da execução, pelo mesmo `usuarioExecucao`, com as mesmas tags e a mesma neutralização.
   Numa demanda retomada após resposta humana ou insumo, o planejador vê a resposta. A conversa entra só no
   prompt: nunca em `agent_events`, no metadata ou nas tabelas do plano.
4. **d17 não é capacidade executora.** d17 é o auditor (`frota:agent-evaluator`, papel `auditor` no
   catálogo). As capacidades de tarefa são `d1`..`d16` e `d18`; o prompt do planejador só oferece essas.
   O schema da resposta aceita d17 (é uma especialidade do domínio) para que um plano que o use vire
   `plano_rejeitado` com o motivo `capacidade_nao_executora`, auditável, em vez de uma falha genérica de
   schema. O banco também recusa d17 em `tarefas.capacidade`. O papel de d17 no catálogo não muda.
5. **Validação determinística, sem modelo** (`validarPlano` em `src/db/planos.ts`): de 1 a 3 especialistas,
   chaves únicas, a chave `integracao` reservada, só capacidades executoras, sem autodependência, sem
   dependência inexistente e sem ciclo. O sistema acrescenta a tarefa de integração, que depende de todas as
   especialistas. Um plano inválido é gravado como `rejeitado` com o motivo em código fechado, sem tarefas.
6. **Ciclos: validados na aplicação e barrados no banco.** `validarPlano` recusa ciclos antes da transação
   que grava o plano. Além disso, o gatilho de `tarefas_dependencias` recusa qualquer aresta cuja tarefa de
   destino já alcance a de origem (CTE recursiva), travando a linha do plano para serializar inserções
   concorrentes no mesmo plano. Assim um ciclo não entra nem por SQL direto. Essa proteção no banco era
   pré-condição da 3.2 e já está nesta migration; a 3.2 não pode removê-la.
7. **Nenhuma transação aberta durante a chamada ao modelo.** A gravação do plano é uma transação curta
   depois da resposta, que trava a linha da demanda só para calcular a próxima versão. O `UNIQUE
   (demanda_id, versao)` é a garantia final.
8. **Fail-open por inteiro.** Qualquer falha do planejamento (API, orçamento, pausa, coordenador fora do
   catálogo ou suspenso, banco) é logada e registrada como `planejamento_falhou` com o código de erro, e a
   demanda segue. Uma parada sistêmica (orçamento, pausa) é tratada pelo fluxo legado logo em seguida, do
   jeito de sempre.
9. **Policy Engine em shadow com `operacao: planejamento`.** `pre`, `during` e `post` do planejamento são
   avaliados com o agente `frota:gestores`. A migration 005 acrescenta só `planejamento` ao vocabulário
   fechado de `operacao` (`CREATE OR REPLACE FUNCTION politica_condicao_valida`, que só acrescenta). O valor
   `integracao` fica para a migration 006, quando essa operação for executada. Como o planejamento acontece
   na mesma run e com os mesmos estágios da execução, a chave de idempotência de `politica_avaliada` inclui
   a operação (`planejamento:pre`), e o metadata ganha `operacao`. As operações legadas ficam como eram.
10. **Modelo de dados (migration 005, aditiva e restrita ao shadow):**
    - `planos_demanda`: `UNIQUE (demanda_id, versao)`, `criado_pela_run_id` com semântica de criação,
      `modo` só `shadow` e `estado` só `registrado` ou `rejeitado` (com motivo). O plano nasce no estado
      final e é imutável: `UPDATE` e `DELETE` bloqueados por gatilho.
    - `tarefas`: só a representação do plano (`id`, `plano_id`, `chave`, `tipo`, `capacidade`, `estado`
      sempre `pendente`, `criado_em`). Sem `demanda_id` (derivável pelo plano). A integração usa sempre a
      capacidade `gestores` e só ela usa. Uma única integração por plano. Só um plano `registrado` recebe
      tarefas. `UPDATE` e `DELETE` bloqueados por gatilho.
    - `tarefas_dependencias`: as duas pontas no mesmo plano, sem autodependência, sem ciclo, append-only.
11. **Eventos novos, só com ids, contagens e códigos:** `plano_registrado` (`planoId`, `versao`, `modo`
    sempre `shadow`, `totalTarefas`, `totalDependencias`), `plano_rejeitado` (`planoId`, `versao`,
    `motivoRejeicao`) e `planejamento_falhou` (`codigoErro`). Nenhuma chave de tarefa, que é texto vindo do
    modelo, entra no ledger.

## O que fica para a migration 006 (entrega 3.2)

Nada disto existe na 005, de propósito:

- em `tarefas`: agente escolhido, tentativas e limite, lease (token e expiração), espera por agente,
  horários de início e fim, código de erro e entrega;
- estados de execução da tarefa e do plano (`modo = 'execucao'`, plano `ativo`, `concluido`, `abandonado`,
  no máximo um ativo por demanda) e a máquina de estados com as transições autorizadas por gatilho. Como a
  005 bloqueia todo `UPDATE` em `planos_demanda` e `tarefas`, a 006 terá de substituir esses gatilhos,
  mantendo planos e tarefas `shadow` imutáveis;
- `operacao: integracao` no Policy Engine e `tarefa_id` nas avaliações e nos eventos;
- `artefatos_tarefa`.

A proteção de ciclo no banco (item 6) continua obrigatória na 006.

## Alternativas descartadas

- **Executar o plano já na 3.1.** Descartada: sem dados de planos reais, o primeiro contato com orquestração
  seria em produção, com efeito na entrega.
- **Deixar o modelo devolver descrição ou instrução por tarefa.** Descartada: seria texto livre do modelo no
  banco sem uso nesta entrega. A instrução de cada tarefa vem na 3.2, com contrato próprio.
- **Manter `tarefas.demanda_id` com FK composta.** Descartada: só duplicaria o dado.
- **Usar `operacao: execucao` para o planejamento.** Descartada: uma regra não conseguiria mirar o planejador
  separado da execução, e os eventos das duas colidiriam na chave de idempotência.

## Consequências

- Custo: uma chamada a mais ao modelo por demanda em `planejar`, contada no orçamento como qualquer outra.
- Com a flag em `desligada` (padrão) nada muda: nenhuma chamada nova, nenhum plano, nenhum evento novo.
- A mesma demanda processada de novo (retomada após insumo humano, por exemplo) ganha um plano de versão
  nova. Os planos anteriores ficam como histórico.
- Os planos ainda não aparecem no dossiê nem na interface. A leitura é por `listarPlanosDaDemanda` e pelos
  eventos na timeline.

## Rollback

- Operacional: `ORQUESTRACAO_TAREFAS=desligada` (ou remover a variável) e novo deploy. O fluxo legado nunca
  deixou de rodar, e as tabelas novas ficam sem uso.
- Código: reverter a PR é seguro. A migration 005 só cria tabelas e acrescenta `planejamento` a uma função, e o código anterior
  não lê nenhuma delas. Os eventos novos continuam legíveis na timeline, porque a leitura do ledger não
  revalida o metadata e o resumo está gravado na linha. Único ponto de atenção: avaliações de política com
  `operacao: planejamento` já gravadas seriam recusadas pelo `listarAvaliacoesDaDemanda` anterior, que valida
  o contexto com o vocabulário antigo. Hoje nenhuma tela usa essa função, só os testes.
- Não há migration de volta: apagar as tabelas é destrutivo e não é necessário para o rollback.
