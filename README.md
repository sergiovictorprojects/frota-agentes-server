# Frota de Agentes — servidor

Serviço que processa a fila de demandas da Frota de Agentes **24 horas por dia, sem depender do computador de ninguém**. Ele guarda tudo num Postgres próprio, chama a API da Anthropic para executar e auditar cada demanda e hospeda as entregas em HTML no próprio domínio.

## Como funciona

```
relógio interno (pg-boss, dentro do Postgres)
  └─ a cada N minutos: processar-fila
       ├─ fila vazia ou frota pausada → termina sem chamar o modelo (custo zero)
       ├─ reivindica até 3 demandas (FOR UPDATE SKIP LOCKED: nunca duas execuções na mesma)
       └─ para cada demanda:
            1. execução com o papel do setor (frota:architect, frota:security-reviewer…)
            2. auditoria por uma chamada separada, com evidência (frota:agent-evaluator)
            3. entrega hospedada em /entregas/<uuid> + relatório + aprendizado
```

- **Orçamento:** toda chamada ao modelo passa por `src/llm/orcamento.ts`. Avisos em 50% e 80% do teto mensal; ao chegar a 100% a frota é pausada sozinha e só volta quando você retomar.
- **Estados da demanda:** `Nova`, `Em andamento`, `Aguardando humano`, `Aguardando insumo`, `Concluída`, `Arquivada`, `Falhou`.
- **Interface:** `/` (fila), `/demandas/nova`, `/demandas/<id>` (o que cada agente fez), `/relatorios`. Login por senha (HTTP Basic).
- **Entregas:** `/entregas/<uuid>` abre sem senha (o UUID é o segredo). A página é uma moldura com o aviso "conteúdo gerado por IA", e o HTML do modelo roda dentro dela num iframe em sandbox: sem rede, sem cookies do site e sem poder navegar a página principal.
- **Saúde:** `GET /health` (sem senha) informa se o banco responde, se a frota está pausada e a última execução.

## Rodando localmente

Requer Node 24 e um Postgres 14+.

```bash
npm install
cp .env.example .env   # preencha os valores
node --env-file=.env src/main.ts
```

```bash
npm test                # 175+ testes, sobem um Postgres embutido sozinhos
npm run test:coverage   # exige 80% de cobertura
npm run typecheck
```

## Variáveis de ambiente

| Variável | Obrigatória | Padrão | Para quê |
|---|---|---|---|
| `DATABASE_URL` | sim | — | Postgres do serviço |
| `ANTHROPIC_API_KEY` | sim | — | Chave **dedicada** a este serviço (`sk-ant-…`) |
| `UI_PASSWORD` | sim | — | Senha da interface: mínimo de 16 caracteres; use uma aleatória de 24 ou mais |
| `PUBLIC_BASE_URL` | sim | — | URL pública, usada nos links das entregas |
| `UI_USER` | não | `frota` | Usuário da interface |
| `MONTHLY_BUDGET_USD` | não | `50` | Teto de gasto mensal com o modelo |
| `CRON_PROCESSAR_FILA` | não | `*/10 * * * *` | Frequência das execuções |
| `MAX_DEMANDAS_POR_RUN` | não | `3` | Demandas por execução |
| `MODEL_WORK` / `MODEL_AUDIT` | não | `claude-sonnet-5` | Modelos de execução e de auditoria |
| `STALE_CLAIM_MINUTES` | não | `90` | Quando uma demanda presa volta para a fila (maior que o prazo de 60 min do job) |
| `PORT` | não | `3000` | Porta HTTP |
| `NOTIFY_CHANNEL` | não | `console` | `email` para receber os avisos por e-mail (além do log) |
| `RESEND_API_KEY` | se `email` | — | Chave do Resend, dedicada a este serviço |
| `NOTIFY_EMAIL_TO` | se `email` | — | Seu e-mail, o destinatário dos avisos |
| `NOTIFY_EMAIL_FROM` | não | `Frota <onboarding@resend.dev>` | Remetente; o de teste só entrega para o e-mail da conta no Resend |

O serviço **não sobe** se faltar uma variável obrigatória ou se o modelo não tiver preço cadastrado em `src/llm/models.ts`.

## Deploy no Railway (passo a passo, feito por você)

1. **Chave da Anthropic.** No Console da Anthropic crie uma chave só para este serviço e defina um limite de gasto mensal na área de limites. Esse limite é a garantia final; o `MONTHLY_BUDGET_USD` é a segunda camada, dentro do código.
2. **Projeto.** No Railway: *New Project → Deploy from GitHub repo* (ou `railway up`). O `railway.json` já manda usar o `Dockerfile` e o health check em `/health`.
3. **Banco.** No mesmo projeto: *New → Database → PostgreSQL*.
4. **Variáveis do serviço.** `DATABASE_URL` com a referência ao Postgres do projeto (rede privada), `ANTHROPIC_API_KEY`, `UI_PASSWORD`, `MONTHLY_BUDGET_USD` e `PUBLIC_BASE_URL`.
5. **Domínio.** *Settings → Networking → Generate Domain* (ou um domínio próprio). Use essa URL em `PUBLIC_BASE_URL` e faça um novo deploy.
6. **Conferir.** Abra `https://<domínio>/health` (deve responder `{"status":"ok",…}`) e entre na interface com o `UI_USER` e a `UI_PASSWORD`.
7. **Vigiar.** Coloque um monitor de uptime gratuito em `/health` e, se puder, um alerta para "nenhuma execução nas últimas 90 minutos" (`ultimaRun.iniciadoEm` no `/health`). Sem isso, o serviço pode cair em silêncio.

Nunca coloque segredos no repositório: `.env` está no `.gitignore` e o `.env.example` só traz nomes.

## Avisos por e-mail (passo a passo, feito por você)

O e-mail vai por uma API HTTPS porque o Railway bloqueia SMTP nos planos Free, Trial e Hobby. O canal usa o Resend.

1. Crie uma conta no [Resend](https://resend.com) **com o e-mail que vai receber os avisos**. Sem domínio verificado, o remetente `onboarding@resend.dev` só entrega para esse e-mail, o que basta para um único destinatário. O plano gratuito permite 100 e-mails por dia.
2. Crie uma chave de API só para este serviço.
3. No Railway, defina `NOTIFY_CHANNEL=email`, `RESEND_API_KEY` e `NOTIFY_EMAIL_TO`, e faça um novo deploy.
4. Se faltar `RESEND_API_KEY` ou `NOTIFY_EMAIL_TO`, o serviço se recusa a subir e diz quais faltam, em vez de descobrir isso só na hora de avisar.

Chegam por e-mail: o resumo de cada execução que processou ou falhou alguma demanda, os avisos de orçamento em 50% e 80% e o aviso crítico de pausa em 100%. Execuções com fila vazia não enviam nada. O log continua registrando todos os avisos, mesmo que o envio de e-mail falhe.

## Migrando os dados do sistema antigo (artifacts)

```bash
DATABASE_URL=… npm run import:legacy -- data/operacao-export.json
```

O arquivo é o export das demandas, mensagens, relatórios e aprendizado do artifact "Operação". A importação é **idempotente** (roda de novo sem duplicar), tudo-ou-nada (uma transação) e recoloca na fila as demandas que estavam "Em andamento". Anexos (imagens) **não** migram: precisam ser reenviados.

**Corte limpo:** desligue a tarefa agendada local (`frota-processar-fila`) antes de ligar o servidor. Nunca deixe as duas rodando ao mesmo tempo.

## Operação do dia a dia

- **Pausar/retomar:** botões na tela inicial. A pausa impede qualquer chamada ao modelo.
- **Executar agora:** botão na tela inicial. Se já houver uma execução na fila ou em andamento, o pedido é descartado.
- **Demanda esperando você:** em "Aguardando humano" ou "Aguardando insumo", responda na página da demanda; ela volta para a fila com a sua resposta.
- **Falhou:** aparece o motivo na linha do tempo; "Tentar novamente" zera as tentativas.
- **Backup do banco:** ative os backups do Postgres no Railway e **teste uma restauração uma vez**. Backup nunca testado não é backup.

## Segurança

- Sem segredos no código; a configuração é validada no boot e os erros citam só o nome da variável.
- Todo SQL é parametrizado; a interface escapa tudo por padrão (`src/http/ui/html.ts`).
- Formulários exigem mesma origem (proteção contra CSRF). O limite de 300 requisições por minuto vale antes da autenticação, então tentativas de senha errada também são contadas.
- O serviço **não confia** no `X-Forwarded-For`: atrás do proxy do Railway todos os clientes dividem o mesmo limite, o que falha fechado (ninguém consegue forjar o IP para escapar), ao custo de um ataque poder esgotar o limite por um minuto. Só ative confiança em proxy depois de confirmar como o Railway monta esse cabeçalho.
- O auditor mede, não bloqueia: um resumo ou uma entrega maliciosos podem enganar a auditoria, então a barreira de segurança real é o isolamento das entregas, não a nota.
- Limite conhecido: o gasto de uma chamada interrompida no meio (queda do processo) não é contabilizado; por isso o limite de gasto no Console da Anthropic é a garantia final.
- O texto das demandas entra no prompt sempre dentro de tags de dados, nunca no prompt de sistema.
- O HTML gerado pelo modelo roda em sandbox, sem rede e sem acesso a cookies do site.
