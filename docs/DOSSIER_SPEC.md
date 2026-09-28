# Especificação do Dossiê da Demanda

## Propósito

O dossiê é a representação auditável de uma demanda. Ele deve permitir compreender a operação inteira sem depender de um formulário simplificado e sem revelar raciocínio interno bruto de modelos.

Ele serve para:

- acompanhamento durante a execução;
- consulta posterior;
- auditoria;
- revisão de falhas;
- medição de qualidade;
- treinamento controlado de agentes;
- evidência de conformidade;
- exportação autorizada.

## Dois modos

### Dossiê em andamento

Consulta dinâmica de uma demanda ainda ativa. Deve indicar que dados podem mudar e apresentar apenas eventos já persistidos.

### Dossiê final

Snapshot versionado criado quando a demanda atinge um estado terminal. Ele preserva a leitura daquele encerramento, mesmo se relatórios ou regras forem atualizados no futuro.

## Seções obrigatórias

| Seção | Conteúdo |
|---|---|
| Resumo executivo | Objetivo, estado final, resultado, risco e responsáveis |
| Dados da demanda | Solicitante, escopo, prioridade, SLA e classificação |
| Linha do tempo | Eventos em ordem cronológica |
| Participantes | Agentes, coordenadores, revisores e usuários envolvidos |
| Etapas | Objetivo, status, entradas, saída resumida, duração e tentativas |
| Decisões | Decisão operacional, justificativa resumida e evidências |
| Conhecimento | Skills, fontes, versões e licenças utilizadas |
| Políticas | Regras avaliadas, decisão, severidade e aprovação |
| Intervenção humana | Solicitações, contexto, decisão, escopo e autor |
| Auditoria | Resultado técnico, ético, evidências e ressalvas |
| Entrega | Artefatos, links autorizados, hash e classificação |
| Métricas | Tempo, custo, tokens, retries, qualidade e retrabalho |
| Aprendizado | Hipóteses de melhoria e status de avaliação |

## O que o dossiê não pode expor

- Cadeia de raciocínio interna do modelo.
- Segredos de infraestrutura.
- Tokens ou chaves.
- Dados pessoais além do necessário para a finalidade.
- Conteúdo de anexos privados sem autorização.
- Dados de outra demanda ou outro usuário.
- Informações de segurança que ampliem a superfície de ataque.

## Modelo de dados recomendado

~~~sql
create table dossier_snapshots (
  id uuid primary key,
  demanda_id uuid not null references demandas(id),
  run_id uuid references runs(id),
  version integer not null,
  status text not null,
  content jsonb not null,
  content_hash text not null,
  generated_at timestamptz not null default now(),
  generated_by text not null,
  access_classification text not null default 'confidential',
  unique (demanda_id, version)
);
~~~

O conteúdo pode ser JSON estruturado. A renderização HTML ou PDF deve ser derivada dele, não ser a única versão do dossiê.

## Endpoint inicial

~~~text
GET /demandas/:id/dossie
GET /demandas/:id/dossie?mode=live
GET /demandas/:id/dossie/versions/:version
~~~

O endpoint deve validar identidade, autorização e escopo antes de retornar qualquer dado.

## Exemplo de contrato resumido

~~~json
{
  "demandId": "uuid",
  "runId": "uuid",
  "mode": "final",
  "generatedAt": "2026-09-28T12:00:00Z",
  "summary": {
    "objective": "Resumo do objetivo",
    "outcome": "Concluída com aprovação",
    "riskLevel": "medium"
  },
  "timeline": [],
  "participants": [],
  "steps": [],
  "policies": [],
  "audit": {},
  "metrics": {},
  "deliveries": [],
  "learning": []
}
~~~

## Geração do snapshot

1. Confirmar que o run está em estado terminal.
2. Consultar dados consistentes de demanda, run, etapas, mensagens, eventos, relatórios, auditorias e entregas.
3. Aplicar redaction e regras de visibilidade.
4. Calcular hash do conteúdo final.
5. Inserir a nova versão do snapshot.
6. Registrar o evento dossier_snapshot_created.
7. Disponibilizar para usuários autorizados.

## Métricas mínimas

- tempo na fila;
- tempo total;
- duração por etapa;
- quantidade de agentes;
- tentativas e retries;
- tempo aguardando humano;
- políticas acionadas;
- violações;
- custo estimado;
- tokens;
- avaliação de qualidade;
- retrabalho;
- status final.
