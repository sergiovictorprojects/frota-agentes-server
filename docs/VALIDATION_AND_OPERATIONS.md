# Validação, Observabilidade e Operação

## Pirâmide de testes

| Nível | O que validar |
|---|---|
| Unitário | Policy Engine, seleção de agente, redaction, validação Zod e geração de dossiê |
| Integração | Migrations, PostgreSQL, repositórios, eventos, ordenação e snapshots |
| Workflow | Fila, worker, retries, intervenção humana, auditoria e entrega |
| Segurança | Permissões, redaction, injeção de prompt, acesso entre papéis e secrets |
| Carga | Concorrência, SSE, volume de eventos, filas e banco |
| Recuperação | Worker interrompido, run abandonado, retry, backup e rollback |
| Aceite | Fluxo completo de uma demanda realista |

## Cenários mínimos de aceite

### Demanda simples

1. Criar demanda.
2. Processar pela fila.
3. Registrar run e etapas.
4. Concluir auditoria.
5. Criar entrega.
6. Consultar dossiê final.

### Validação de entrada e entrega

1. Criar demanda com resultado esperado e critérios de aceite.
2. Escolher uma categoria incompatível (por exemplo, `gestores` para uma interface).
3. Confirmar que a regra bloqueia ou exige confirmação, sem alterar a categoria silenciosamente.
4. Aceitar a recomendação ou escolher uma categoria compatível.
5. Processar a demanda e verificar que a conclusão contém o tipo de entrega exigido.
6. Consultar evento/dossiê com a regra aplicada, recomendação, confirmação e motivo da rota.

### Demanda com insumo humano

1. Agente identifica lacuna.
2. Sistema altera estado para aguardando insumo.
3. Usuário fornece informação.
4. Run é retomado.
5. Dossiê mostra pausa, resposta e retomada.

### Política em shadow

1. Ação de alto risco é proposta.
2. Policy Engine produz deny ou require_approval.
3. A execução continua apenas porque a regra ainda está em shadow.
4. Dossiê mostra o comportamento esperado.

### Política em enforce

1. Ação crítica é proposta.
2. Policy Engine bloqueia ou solicita humano.
3. Sem aprovação, a ação não ocorre.
4. Evento e auditoria registram o bloqueio.

### Falha e recuperação

1. Worker falha durante etapa.
2. Run fica recuperável.
3. Retry respeita limite e idempotência.
4. Nenhuma entrega duplicada é criada.
5. Dossiê mostra tentativas e causa.

### Isolamento de acesso

1. Usuário sem permissão tenta acessar dossiê alheio.
2. API nega acesso.
3. SSE não transmite eventos não autorizados.
4. Tentativa é registrada de forma segura.

## Métricas operacionais

| Grupo | Métricas |
|---|---|
| Fila | profundidade, espera, idade da mensagem, jobs falhos |
| Execução | duração, sucesso, falha, retry, timeout e abandono |
| Agentes | utilização, concorrência, qualidade, custo e intervenção |
| Política | avaliações, alertas, bloqueios, aprovações e falsos positivos |
| Conhecimento | fontes usadas, citações válidas, latência e custo |
| Dossiê | completude, falhas de geração e tempo de montagem |
| Segurança | falhas de login, negações, rate limit e acessos suspeitos |
| Infraestrutura | CPU, memória, conexões, banco, erros e disponibilidade |

## Alertas iniciais

- Worker sem processar durante período esperado.
- Fila crescendo acima do limite.
- Número de falhas ou retries acima da linha de base.
- Gasto de modelo acima do orçamento.
- Política crítica bloqueando em alta frequência.
- Erro na geração de dossiê.
- Backup falhando.
- Aumento de falhas de login ou negações de acesso.
- SSE com conexões excessivas ou atraso elevado.

## Runbooks mínimos

### Pausar frota

1. Acionar flag global.
2. Confirmar que novos jobs não iniciam.
3. Manter execução segura de passos já iniciados ou interrompê-los conforme política.
4. Registrar incidente e motivo.
5. Comunicar usuários afetados.

### Reverter deploy

1. Interromper publicação.
2. Reverter para imagem ou release anterior.
3. Não aplicar migration destrutiva.
4. Validar health check, fila e banco.
5. Registrar versão e causa.

### Revogar credencial

1. Revogar no gerenciador de segredos ou provedor.
2. Rotacionar onde necessário.
3. Invalidar sessões e integrações afetadas.
4. Revisar logs de uso.
5. Registrar incidente.

### Restaurar banco

1. Criar ambiente isolado.
2. Restaurar backup.
3. Validar integridade, dossiês, eventos e entregas.
4. Medir tempo de restauração.
5. Documentar resultado.

## Definition of Done por alteração

- [ ] Escopo e objetivo definidos.
- [ ] Arquivos e impacto revisados.
- [ ] Contratos validados com Zod quando aplicável.
- [ ] Migration aditiva e revisada.
- [ ] Dados sensíveis tratados.
- [ ] Testes adicionados ou atualizados.
- [ ] Typecheck executado.
- [ ] Testes relevantes executados.
- [ ] Logs e eventos adequados.
- [ ] Documentação atualizada.
- [ ] Rollback definido.
- [ ] Nenhuma regressão conhecida no fluxo atual.
