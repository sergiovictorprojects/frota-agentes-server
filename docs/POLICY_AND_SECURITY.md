# Policy Engine, Segurança e Acesso à Aplicação

## Objetivo

Segurança, ética e governança devem ser propriedades do sistema, não apenas instruções de prompt. Este documento define a postura de produção da aplicação depois de finalizada.

## Princípios

1. Negar por padrão ações de alto risco sem regra explícita.
2. Aplicar menor privilégio a usuários, agentes, ferramentas e serviços.
3. Manter dados sensíveis fora de prompts, eventos e interfaces quando não forem necessários.
4. Registrar decisões de segurança e políticas de forma auditável.
5. Separar ambientes de desenvolvimento, homologação e produção.
6. Testar restauração de backup, não apenas a geração de backup.
7. Nunca depender exclusivamente de modelo de linguagem para bloquear ações críticas.

## Policy Engine

### Papel

O Policy Engine traduz o Código de Conduta em regras versionadas e avaliáveis antes, durante e depois da operação.

Ele não é um agente comum. Ele é uma camada de controle do sistema.

### Estágios

| Estágio | Quando executar | Exemplos |
|---|---|---|
| pre | Antes de criar ou iniciar uma execução | demanda proibida, prioridade, dados sensíveis |
| during | Antes de ação, ferramenta ou publicação | chamada externa, alteração destrutiva, uso de credencial |
| post | Depois de execução ou antes do fechamento | auditoria, conformidade, retenção, entrega |

### Decisões

| Decisão | Efeito |
|---|---|
| allow | Permite continuar |
| warn | Permite, mas registra alerta |
| require_approval | Pausa e exige aprovação humana |
| deny | Bloqueia a ação |

### Estrutura inicial

~~~sql
create table policy_rules (
  id uuid primary key,
  code text not null unique,
  name text not null,
  description text not null,
  stage text not null,
  severity text not null,
  decision text not null,
  condition jsonb not null,
  version integer not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table policy_evaluations (
  id uuid primary key,
  demanda_id uuid not null references demandas(id),
  run_id uuid references runs(id),
  agent_step_id uuid references agent_steps(id),
  policy_rule_id uuid not null references policy_rules(id),
  decision text not null,
  reason text not null,
  evidence jsonb not null default '{}'::jsonb,
  evaluated_at timestamptz not null default now()
);
~~~

Não aplicar esse SQL sem adaptar nomes, tipos e chaves ao banco existente.

### Modo de ativação

1. shadow: avalia e registra, sem bloquear.
2. warn: exibe alertas e exige acompanhamento.
3. enforce: bloqueia regras críticas já validadas.

Toda regra deve ter testes positivos, negativos, de borda e de regressão.

## Identidade e acesso

O repositório privado e a aplicação privada são controles diferentes.

| Item | Responsabilidade |
|---|---|
| GitHub privado | Protege código, histórico e configurações |
| Domínio HTTPS | Oferece endereço seguro para acesso |
| Autenticação | Identifica quem entra na aplicação |
| Autorização | Define o que cada pessoa pode fazer |
| Banco privado | Protege persistência e dados internos |
| VPN ou Zero Trust | Restringe origem de acesso quando necessário |

### Acesso em outros dispositivos

Depois do deploy em nuvem, a aplicação deve ser acessada por navegador em endereço estável, por exemplo:

~~~text
https://frota.seudominio.com.br
~~~

O mesmo usuário poderá utilizar computador pessoal, computador corporativo, tablet ou celular, desde que se autentique. O computador local não precisa permanecer ligado para a aplicação funcionar.

### Opções de exposição

| Modelo | Uso indicado | Controles mínimos |
|---|---|---|
| Internet privada | Usuários remotos autorizados | HTTPS, login, MFA, RBAC, rate limit e auditoria |
| Zero Trust ou VPN | Operação interna com maior restrição | Identidade corporativa, dispositivo autorizado e regras de acesso |
| Rede local | Protótipo ou ambiente isolado | Não indicada para produção distribuída |

### Papéis iniciais

| Papel | Permissões principais |
|---|---|
| Administrador | Configuração, agentes, políticas, usuários, auditoria e operação |
| Coordenador | Acompanhar demandas, revisar etapas e aprovar dentro do escopo |
| Auditor | Consultar dossiês, métricas e evidências sem alterar execução |
| Operador | Criar e acompanhar demandas permitidas |
| Solicitante | Criar demandas e consultar apenas as próprias |
| Serviço interno | Permissões mínimas para worker, API ou integração |

Use RBAC no início. Caso o produto tenha escopos complexos por organização, unidade, demanda ou documento, evoluir para políticas de acesso por atributo.

## Autenticação

Autenticação HTTP Basic pode ser aceita para protótipo controlado, mas não é a meta de produção.

Para produção, usar:

- provedor de identidade confiável;
- sessões curtas e renováveis ou tokens seguros;
- MFA para administradores e coordenadores;
- recuperação de conta protegida;
- revogação de sessão;
- bloqueio e alerta contra tentativas repetidas;
- auditoria de login, logout e falhas.

Nunca manter senhas em texto puro. Senhas próprias devem usar hash forte e salt; preferir identidade federada quando possível.

## Proteção de dados

### Em trânsito

- HTTPS obrigatório.
- TLS entre serviços sempre que a infraestrutura permitir.
- Rejeitar HTTP em produção.
- Cookies com Secure, HttpOnly e SameSite adequados quando houver sessão baseada em cookie.

### Em repouso

- Banco e armazenamento de objetos com criptografia gerenciada.
- Backups criptografados.
- Segredos somente em gerenciador de segredos ou variáveis protegidas do provedor.
- Chaves rotacionáveis e sem commit no Git.

### Classificação

Cada anexo, entrega e artefato deve ter classificação:

- public;
- internal;
- confidential;
- restricted.

A classificação governa quem pode ler, exportar, reter e compartilhar o conteúdo.

### Redaction

Antes de enviar dados para modelo, log, evento ou SSE:

1. identificar dados pessoais, credenciais e informações confidenciais;
2. remover ou mascarar o que não for necessário;
3. registrar que ocorreu redaction sem expor o conteúdo removido;
4. preservar o original somente quando autorizado e em armazenamento protegido.

## Segurança de agentes e ferramentas

- Ferramentas devem funcionar por allowlist.
- Cada agente recebe somente permissões necessárias.
- Chamadas externas exigem política, timeout, limite de custo e registro.
- Ações destrutivas exigem aprovação humana explícita.
- Credenciais de ferramentas não podem ser passadas em prompts.
- Limitar origem, destino, método e escopo de integrações.
- Validar saída estruturada com Zod antes de alterar estado ou chamar ferramenta.
- Tratar anexos e conteúdo externo como não confiáveis para reduzir prompt injection.
- Não permitir que instruções vindas de documentos alterem políticas, permissões ou o próprio prompt do sistema.

## Segurança da API e interface

- Validar toda entrada.
- Usar rate limiting e limites por usuário.
- Configurar CORS somente para origens necessárias.
- Adicionar headers de segurança.
- Proteger CSRF quando houver cookies de sessão.
- Não retornar stack trace ao usuário.
- Registrar falhas de autorização e tentativas suspeitas.
- Paginar endpoints de eventos e dossiês.
- Aplicar limites de tamanho a anexos e payloads.

## Segurança do banco e da nuvem

- Banco sem exposição pública direta.
- Acesso do banco apenas por serviços autorizados e rede privada quando possível.
- Usuário de banco distinto para API, worker e migrações quando o provedor permitir.
- Permissões mínimas por serviço.
- Migrations revisadas e aplicadas de forma controlada.
- Backups automáticos e teste periódico de restauração.
- Ambiente de produção separado de desenvolvimento e homologação.
- Segredos separados por ambiente.

## Operação e resposta a incidentes

Manter:

- health checks;
- métricas de erro, latência, fila, custo e uso de banco;
- alertas para falha de worker, fila parada, aumento de erro, gasto anômalo e tentativa de acesso suspeita;
- runbook de incidente;
- procedimento de revogação de chaves;
- procedimento de pausa global da frota;
- procedimento de rollback de deploy, skill, prompt e política;
- registro de incidente e revisão posterior.

## Checklist antes de produção

- [ ] Domínio próprio com HTTPS.
- [ ] Autenticação forte e MFA administrativo.
- [ ] RBAC testado.
- [ ] Banco não exposto publicamente.
- [ ] Segredos fora do repositório.
- [ ] Backups e restauração testados.
- [ ] Logs sem dados sensíveis desnecessários.
- [ ] Policy Engine em modo shadow validado.
- [ ] Rate limiting e validação de entrada ativos.
- [ ] Monitoramento e alertas configurados.
- [ ] Teste de autorização entre papéis.
- [ ] Teste de recuperação de fila e worker.
- [ ] Procedimento de incidente documentado.
