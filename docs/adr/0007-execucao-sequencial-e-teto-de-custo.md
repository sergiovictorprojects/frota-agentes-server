# ADR 0007 — Execução sequencial por tarefas e teto de custo (entrega 3.2a: base de dados e funções puras)

## Status

Entrega 3.2a implementada na branch `fase-3/execucao-tarefas-base`, em PR draft. Ela não liga nada: a flag
`ORQUESTRACAO_TAREFAS` continua aceitando só `desligada` e `planejar`, nenhuma chamada nova ao modelo existe e os
repositórios novos só são chamados pelos testes. A entrega 3.2b (liga a orquestração, a flag `executar`, o prompt
serializado, os timeouts, a interface de autorização e o script de verificação de rollback) exige aprovação própria.

Base: plano `fase-3.2-execucao-sequencial.md`, versão 4, aprovado em 2026-09-29 sobre a master `ed8cdad`.

## Contexto

A entrega 3.1 (ADR 0006) só grava planos em shadow. Para executar tarefas especialistas e uma integração que
produz a entrega única, o sistema precisa de garantias que não dependam do código que chama: nenhuma transação
aberta durante a chamada ao modelo, tentativa contada uma vez só, resultado atrasado descartado, custo por demanda
com teto, histórico que não se apaga e nenhum texto do modelo no ledger. A decisão 6A dividiu a 3.2 em duas PRs:
esta traz o banco, os repositórios e as funções puras, testados, sem mudar o processamento real.

## Decisão

1. **Migration 006 aditiva** (`src/db/migrations/006_execucao_tarefas.sql`). Nenhuma coluna existente é removida ou
   muda de significado, nenhuma linha existente é alterada e não há backfill. As colunas novas são anuláveis ou têm
   padrão (`tarefas.tentativas` 0 e `max_tentativas` 2). Os `CHECK` antigos são trocados por versões que só ampliam.
   Os gatilhos da 005 são substituídos por versões que mantêm o comportamento dela para planos e tarefas shadow,
   que continuam imutáveis. Todas as FKs novas são `ON DELETE RESTRICT`, e nenhuma tabela nova aceita `DELETE`.
2. **Envelope da demanda** (`orquestracao_demandas`). Criado na primeira vez que a demanda entra na orquestração e
   nunca apagado. O teto base (`numeric(8,2)`, de 1,00 a 20,00) e a identidade são imutáveis. A rota só muda de
   `tarefas` para `legado_fixo`, uma vez, com o motivo. O bloqueio por custo só sai com uma linha de
   `autorizacoes_custo` gravada na mesma transação (`transacao = txid_current()`, preenchida pelo banco). Um
   gatilho adiado para o `COMMIT` impede que a rota `legado_fixo` conviva com plano ativo.
3. **Plano em execução** (`planos_demanda.modo = 'execucao'`). Só nasce com o envelope na rota `tarefas`.
   Transições `registrado → ativo` e `ativo → concluido | abandonado`, com as datas gravadas pelo banco. No máximo
   um plano ativo por demanda (índice único parcial). A ativação confere a forma no banco: exatamente uma integração,
   de 1 a 3 especialistas, todas com objetivo, aresta da integração para cada especialista e nenhuma especialista
   dependendo da integração. `concluido` exige a integração concluída e com entrega. No `COMMIT`, um plano encerrado
   não pode ter tarefa aberta, e o abandono por `tarefa_falhou` ou `agente_indisponivel` exige a rota `legado_fixo`
   com o mesmo motivo. Depois da ativação, o grafo fica congelado: nem tarefa nem aresta nova.
4. **Máquina de estados da tarefa** (gatilho `tarefas_controla`). Os repositórios (`src/db/tarefas.ts`) só escolhem a
   transição; o banco recusa qualquer outra, mesmo por SQL direto:

   | De | Para | Condição imposta pelo banco |
   |---|---|---|
   | `pendente` | `pronta` | Plano ativo e todas as dependências concluídas |
   | `pronta` | `em_execucao` | Claim: plano ativo, tentativa restante, lease com validade e snapshot de um agente `ativo` da capacidade, com versão, papel e modelo do catálogo. O banco gera `claim_id` e `lease_token` |
   | `em_execucao` | `em_execucao` | Registro de envio, uma vez por claim e com o plano ativo: a tentativa sobe exatamente 1, o lease é renovado, o agente do snapshot continua ativo, na mesma versão e com o mesmo modelo, e existe uma reserva aberta do mesmo claim |
   | `em_execucao` | `concluida` | Envio registrado, plano ativo e artefato gravado. Integração: entrega da mesma demanda |
   | `em_execucao` | `pronta` | Ainda há tentativa e o plano está ativo. O snapshot é limpo |
   | `em_execucao` | `falhou` | Código fechado, nunca `contexto_excedido` |
   | `pronta` | `falhou` | Só `contexto_excedido`, com o plano abandonado por `tarefa_falhou` na mesma transação |
   | `pendente`, `pronta`, `em_execucao` | `cancelada` | Plano já abandonado na mesma transação |

   A tentativa nunca desce e só sobe no registro de envio, nunca no claim. Em toda saída de `em_execucao`, o gatilho
   limpa `claim_id`, `lease_token` e `lease_expira_em`, então nenhum caminho os esquece; cada repositório devolve o
   `claimId` lido antes da transição, para o evento. O timeout é do banco: 480 segundos para especialista e 720 para
   integração. O objetivo (decisão 1B) tem de 1 a 300 caracteres, sem caracteres de controle (C0, DEL, C1, U+2028 e
   U+2029), sem `<` e sem `>`, e é imutável.
5. **Lease e sigilo.** O lease vale o timeout mais 180 segundos (`MARGEM_LEASE_SEGUNDOS`), mais que a margem de
   persistência de 2 minutos do plano. Só o `lease_token` autoriza persistir (condição de `WHERE`); ele sai do
   repositório só para o processo que fez o claim e nunca vai para evento, log, interface ou listagem. O `claim_id`
   pode ir para eventos e avaliações: identifica o claim, mas não autoriza nada.
6. **Artefatos** (`artefatos_tarefa`). Um por tarefa, append-only, aceito só com a tarefa em execução e com o envio
   registrado. O servidor calcula `sha256` e `bytes`, e o banco confere os dois. Limite de 65.536 bytes para
   especialista e 131.072 para integração, JSON válido quando o formato é `json`, até 10 referências em três formas
   fechadas (`url`, `fonte`, `artefato`) validadas por uma função SQL equivalente ao Zod, e referência a artefato só
   para uma dependência direta. `classificacao` é sempre `interna`. **Duplicação deliberada:** o artefato da
   integração é o resultado da execução sem o conteúdo da entrega, o que depois vai também para `relatorios`. A cópia
   existe para a retomada: se o processo cair entre a integração e o relatório, a próxima execução só faz a
   auditoria, sem nova integração nem nova entrega. O conteúdo de artefato nunca vai para eventos, logs, dossiê ou
   interface; só `listarArtefatosDasDependencias` o lê, para o prompt.
7. **Custo por demanda.** O limite é o teto base mais a soma das autorizações. O comprometido é todo o gasto em
   `agent_steps` da demanda (com o histórico inteiro, inclusive de antes do envelope) mais as reservas `aberta`,
   `retida` e `reconhecida`. Nada zera o comprometido. As duas contas são funções SQL únicas
   (`orquestracao_limite_usd` e `orquestracao_comprometido_usd`), usadas pelo gatilho e pelo repositório.
   - **Reserva** (`reservas_custo`): gravada com o envelope travado e só se couber no limite. O gatilho repete a
     conta sob o mesmo lock, então nem SQL direto passa do limite nem reserva numa demanda bloqueada. Uma reserva
     de tarefa pertence ao claim atual, antes do envio, com o modelo e a operação do snapshot, e é única por claim.
     Estados `aberta → liquidada | cancelada | retida` e `retida → reconhecida`.
   - **Liquidação:** o `agent_steps` com o custo real e a liquidação na mesma transação. `agent_step_id` é FK para
     `agent_steps` e `UNIQUE`: um passo liquida no máximo uma reserva, e o banco confere que o passo é da mesma
     chamada (demanda, plano, tarefa, operação, modelo e custo). Liquidar de novo uma reserva já liquidada devolve o
     passo gravado, sem contar o gasto duas vezes. Uma resposta que chega depois de a reserva ter sido retida grava
     o custo real mesmo assim e deixa a reserva retida: a demanda conta os dois, o lado seguro.
   - **Cancelar e reter nunca criam `agent_steps`**: erro sem uso não gera passo artificial.
   - **Autorização** (`autorizacoes_custo`, append-only): de US$ 0,50 a 5,00 no Zod e no banco, só para demanda
     bloqueada, com `limite_anterior_usd` conferido sob lock contra o limite atual e `limite_novo_usd` igual ao
     anterior mais o valor. Duas autorizações concorrentes nunca passam juntas.
8. **Dinheiro sem ponto flutuante.** Preços da tabela fechada como texto decimal, tokens e bytes inteiros, conta em
   micro-dólares com `bigint` (`src/llm/reserva.ts`) e `numeric(12,6)` no banco. A reserva é arredondada para cima e
   o custo real para o mais próximo, com 6 casas. A fórmula da reserva é a do plano: bytes de entrada × preço de
   entrada × 1,25 mais `max_tokens` × preço de saída; `max_tokens` acima da saída máxima do modelo é recusado. O
   fluxo legado (demandas sem envelope) continua com `custoUsd`, que devolve exatamente os mesmos valores de antes.
9. **Tabela de modelos** (`src/llm/models.ts`): preço, janela de contexto e saída máxima, conferidos em
   2026-09-29 na documentação oficial (`MODELOS_VERIFICADOS_EM`), nas páginas de preços, de janelas de contexto e de
   cada modelo. Modelo sem preço ou sem janela falha antes de qualquer reserva ou envio.

   | Modelo | Entrada / saída (US$ por milhão de tokens) | Janela | Saída máxima |
   |---|---|---|---|
   | `claude-fable-5-1` | 10 / 50 | 1.000.000 | 128.000 |
   | `claude-opus-5` | 5 / 25 | 1.000.000 | 128.000 |
   | `claude-sonnet-5` | 2 / 10 | 1.000.000 | 128.000 |
   | `claude-haiku-4-5` | 1 / 5 | 200.000 | 64.000 |

   A escrita no cache continua a 1,25x a entrada e a leitura a 0,1x. A documentação cobra menos na leitura do cache
   do Fable 5.1 (0,025x); manter 0,1x superestima, nunca subestima.
10. **Serialização canônica** (`src/orchestrator/serializacao.ts`). Objeto de forma fechada validado por Zod,
    `JSON.stringify`, troca de `<`, `>`, `&`, U+2028 e U+2029 por `\uXXXX` e um único par
    `<dados formato="json">…</dados>`: nenhum dado vira atributo, nenhum dado fecha o bloco e `JSON.parse` devolve
    o original. Limites em bytes UTF-8 medidos depois do escape: até 131.072 bytes de artefatos e a entrada inteira
    até o menor entre 262.144 bytes de prompt de usuário e a janela do modelo menos `max_tokens`. A redução é
    determinística e nunca corta texto no meio: artefatos grandes entram só com o resumo, depois saem as mensagens
    mais antigas da conversa e, por fim, é `contexto_excedido`. As tags não são a fronteira de segurança (seção 5.5
    do plano); a 3.2b é quem usa esta função nos prompts.
11. **Eventos.** 17 tipos novos, cada um com schema Zod estrito (tabela em `docs/EVENT_TAXONOMY.md`), e sete códigos
    de erro novos. A coluna `agent_events.tarefa_id` é obrigatória nos eventos de tarefa, opcional nos de custo,
    em `entrega_criada` e em `politica_avaliada`, e proibida nos demais; o banco confere que a tarefa é da mesma
    demanda. Regras cruzadas, conferidas antes de qualquer escrita: `tarefa_falhou` tem `claimId` nulo, ator
    `sistema` e `definitiva` exatamente em `contexto_excedido`; `politica_avaliada` leva `claimId` junto com
    `tarefaId`, e só com ele; dólares são números com até 6 casas. Nenhum evento leva `lease_token`, chave ou
    objetivo de tarefa, conteúdo, resumo ou referência de artefato, URL, prompt ou texto de erro.
12. **Policy Engine por tarefa (shadow).** `avaliacoes_politica` ganha `tarefa_id` e `claim_id` (os dois ou
    nenhum). O banco confere a demanda, a operação da tarefa (`execucao` para especialista, `integracao` para
    integração) e, no estágio `pre`, o snapshot exato do claim atual. `politica_condicao_valida` ganha só o valor
    `integracao`. A chave de idempotência de uma avaliação por tarefa é `operacao:tarefaId:claimId:estagio`, então
    claims repetidos antes do envio geram avaliações distintas. `avaliarEregistrar` continua fail-open: se o banco
    recusar a avaliação, ela devolve `allow` e nada é gravado. As avaliações sem tarefa ficam exatamente como eram.
13. **Ordem de locks**, a mesma em todas as funções que travam mais de uma linha: plano, tarefa, agente e envelope.
    Funções que recebem um cliente (`reservarCustoNaTransacao`, `autorizarCustoAdicional`, `bloquearPorCusto`,
    `abandonarPlano`, `promoverTarefasProntas`, `fixarRotaLegado`) rodam na transação de quem chama, para a 3.2b
    compor as transações únicas do plano (por exemplo: devolver a tarefa, bloquear a demanda e mudar o estado dela).
    As demais abrem uma transação curta própria. Nenhuma fica aberta durante uma chamada ao modelo.
14. **Testes em PostgreSQL 16.** O `embedded-postgres` dos testes passou de 18 para 16.14, a versão principal do
    template padrão de PostgreSQL do Railway. A versão do banco de produção não foi conferida (não há acesso a ele
    a partir deste trabalho). A migration usa só recursos presentes desde o PostgreSQL 13 (`gen_random_uuid`,
    gatilhos de restrição adiáveis, `jsonb`, expressões regulares). O teste de upgrade confere que roda na major 16.
15. **Teste de upgrade 005 → 006.** `migrate(pool, { ate })` (só os testes usam) monta um banco parado na 005, com
    planos shadow, tarefas, arestas, `agent_steps`, avaliações e eventos gravados pelo SQL da 3.1. Depois da 006,
    todas as colunas antigas continuam com os mesmos valores, os planos shadow continuam imutáveis, o SQL da 3.1
    continua gravando planos shadow válidos e o código novo lê as linhas antigas.

## Divergências em relação ao texto do plano

Todas apertam uma regra; nenhuma afrouxa:

- `em_execucao → falhou` recusa `contexto_excedido` (o plano só exigia um código). Mantém o banco coerente com o
  evento `tarefa_falhou`.
- A margem do lease foi fixada em 180 segundos (o plano só dizia "maior que o timeout mais a margem").
- `reservarCusto` valida os parâmetros antes de qualquer lock e lança erro para parâmetro fora do formato, em vez de
  devolvê-lo como motivo de recusa.
- A liquidação repetida é idempotente, e a liquidação depois da retenção conta os dois valores (casos que a tabela
  6.3 do plano não cobria).

## Fronteiras: o que a 3.2a não faz

- Não aceita `ORQUESTRACAO_TAREFAS=executar` nem lê `ORQUESTRACAO_CATEGORIA` ou `ORQUESTRACAO_CUSTO_MAX_USD`.
- Não muda `processar-demanda`, `processar-fila`, os prompts, o cliente da API ou `LlmComOrcamento`.
- Não cria endpoint nem tela. A única mudança visível fora dos testes é a leitura de eventos: o JSON de
  `GET /demandas/:id/eventos` ganha `tarefaId`, nulo em todos os eventos de hoje.
- Com a flag em `planejar`, o plano shadow é gravado como na 3.1 (a coluna `objetivo` fica nula).
- Em produção, depois do deploy, as tabelas novas ficam vazias: nada no fluxo real cria envelope, reserva,
  autorização, plano em execução ou artefato.

## Limites conhecidos

- O custo realizado pode passar do limite quando uma chamada custa mais que a própria reserva
  (`custo_acima_da_reserva`). É um teto por reserva, como o plano descreve.
- O banco garante que a reserva é positiva e cabe no limite, mas não recalcula o valor: a fórmula é aplicada pelo
  código (`reservaUsd`).
- A autorização final do agente é conferida no claim e no registro de envio; uma suspensão depois do envio não
  interrompe a chamada em curso.
- Um `INSERT` direto em `reservas_custo` com tarefa trava o envelope antes da tarefa, a ordem inversa da aplicação.
  Só SQL manual chega a esse caminho; um impasse com a aplicação seria detectado e desfeito pelo PostgreSQL.
- Até a Fase 9 há um único login: `autorizado_por` e `reconhecida_por` separam ação e registro, não pessoas.
- A lista de status HTTP que cancelam a reserva (seção 6.3 do plano) é da 3.2b; aqui existem só `cancelarReserva`,
  `reterReserva` e a varredura `reterReservasVencidas`.
- A tabela de modelos tem o alias `claude-haiku-4-5`; o identificador com data (`claude-haiku-4-5-20251001`) não
  está cadastrado e seria recusado no boot, falhando fechado.
- A versão do PostgreSQL de produção não foi confirmada (decisão 14).

## Alternativas descartadas

- **Gerar `claim_id` e `lease_token` na aplicação.** Descartada: gerados pelo gatilho, nenhum chamador escolhe ou
  reaproveita um token, nem por SQL direto.
- **Contar a tentativa no claim.** Descartada (versão 4 do plano): claims repetidos antes do envio consumiriam
  tentativas sem nenhuma chamada.
- **Somar custo em ponto flutuante.** Descartada: arredondamentos acumulados podem deixar passar ou barrar uma
  reserva na borda do limite; `numeric` e `bigint` são exatos.
- **Reserva só em memória.** Descartada: uma queda entre a reserva e a liquidação perderia o valor comprometido; a
  reserva persistida continua contando e vira `retida` na varredura.
- **Regras só no código.** Descartada: o princípio do projeto é que política e segurança não dependam só de quem
  chama. As regras de estado, tentativa, lease, custo, autorização e artefato são repetidas no banco. Ficam só na
  aplicação o schema do metadata dos eventos (como desde a Fase 1) e a recusa de objetivo feito só de espaços.
- **Manter os testes no PostgreSQL 18.** Descartada: o critério aprovado pede a major do Railway nos testes de
  integração.
- **Apagar em cascata.** Descartada: histórico de custo, artefato e evento nunca se apaga; todas as FKs são
  `RESTRICT`.

## Consequências

- No próximo deploy, a 006 roda no boot, numa transação: troca gatilhos, acrescenta colunas e cria índices,
  inclusive `agent_steps (demanda_id)`. O índice é criado sem `CONCURRENTLY`, então `agent_steps` fica travada para
  escrita durante a criação; com o volume de hoje isso leva pouco tempo.
- A suíte de testes cresce e roda no PostgreSQL 16 embutido.
- A 3.2b encontra prontos o banco, os repositórios, a serialização, os limites e a conta de custo; o que ela
  acrescenta é o fluxo que os usa.

## Rollback

- **Operacional:** nada a desligar. A 3.2a não é chamada pelo fluxo real.
- **Código:** reverter a PR é seguro com a 006 já aplicada. O código anterior grava e lê planos shadow, eventos,
  avaliações e `agent_steps` pelas colunas que já existiam (o teste de upgrade roda o SQL da 3.1 sobre a 006), e as
  tabelas novas ficam vazias. `schema_migrations` guarda a 006; reaplicar a 3.2a depois não roda a migration de
  novo.
- **Migration:** não há migration de volta. Apagar colunas, tabelas ou gatilhos seria destrutivo e não é
  necessário para o rollback.
- O procedimento de rollback da 3.2b (planos ativos, demandas bloqueadas, reservas abertas e retidas) está na seção
  11 do plano e vai para o README com ela.
