export const CATEGORIAS = [
  'gestores',
  'd1',
  'd2',
  'd3',
  'd4',
  'd5',
  'd6',
  'd7',
  'd8',
  'd9',
  'd10',
  'd11',
  'd12',
  'd13',
  'd14',
  'd15',
  'd16',
  'd17',
  'd18',
] as const;
export type Categoria = (typeof CATEGORIAS)[number];

export const PRIORIDADES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type Prioridade = (typeof PRIORIDADES)[number];

export const STATUS = [
  'Nova',
  'Em andamento',
  'Aguardando humano',
  'Aguardando insumo',
  'Concluída',
  'Arquivada',
  'Falhou',
] as const;
export type StatusDemanda = (typeof STATUS)[number];

export interface Setor {
  id: Categoria;
  nome: string;
  // Papel próprio do servidor. Nunca reutiliza os nomes `ecc:*` do Claude Code local.
  papel: string;
  // Cada item é uma regra auditável separadamente.
  regras: readonly string[];
  // Setores somente-leitura ou de delegação não produzem páginas hospedadas.
  podeEntregarHtml: boolean;
}

function setor(id: Categoria, nome: string, papel: string, regras: readonly string[], podeEntregarHtml = true): Setor {
  return { id, nome, papel, regras, podeEntregarHtml };
}

export const SETORES: Readonly<Record<Categoria, Setor>> = {
  gestores: setor(
    'gestores',
    'Gestores',
    'frota:gestores',
    ['Nunca implementa direto — sempre delega a um coordenador ou colaborador'],
    false,
  ),
  d1: setor('d1', 'Arquitetura & Sistema', 'frota:architect', [
    'Toda decisão de arquitetura registra alternativas consideradas e trade-offs',
  ]),
  d2: setor(
    'd2',
    'Pesquisa & Descoberta',
    'frota:code-explorer',
    ['Não modifica nada — apenas lê e relata (read-only)'],
    false,
  ),
  d3: setor('d3', 'Qualidade & Revisão', 'frota:code-reviewer', [
    'CRITICAL bloqueia merge',
    'HIGH exige justificativa para seguir',
  ]),
  d4: setor('d4', 'Segurança', 'frota:security-reviewer', ['Nenhum CRITICAL de segurança passa sem correção']),
  d5: setor('d5', 'Build & CI/CD', 'frota:build-error-resolver', [
    'Mudança mínima necessária — nunca refatoração arquitetural durante o fix',
  ]),
  d6: setor('d6', 'Testes & Validação', 'frota:tdd-guide', [
    'Cobertura mínima de 80%',
    'Zero mock em caminho de produção',
  ]),
  d7: setor('d7', 'Infra Distribuída/Swarm', 'frota:hierarchical-coordinator', [
    'Tolera até f<n/3 nós falhos sem perder consistência',
  ]),
  d8: setor('d8', 'Documentação & Conhecimento', 'frota:doc-updater', [
    'Documentação nunca descreve comportamento que o código não tem',
  ]),
  d9: setor('d9', 'Limpeza & Manutenção', 'frota:refactor-cleaner', [
    'Toda remoção é verificada com teste antes de confirmar',
  ]),
  d10: setor('d10', 'Performance & Otimização', 'frota:performance-optimizer', [
    'Nenhuma otimização entra sem medição de antes/depois',
  ]),
  d11: setor('d11', 'Design & Produto', 'frota:product-designer', [
    'Sempre usa tokens do design system, nunca valor hardcoded',
  ]),
  d12: setor('d12', 'Release Open Source', 'frota:opensource-sanitizer', [
    'PASS obrigatório do sanitizador antes de qualquer publicação',
  ]),
  d13: setor('d13', 'Loop Generativo/GAN', 'frota:gan-planner', [
    'Nº máximo de iterações definido antes de começar o loop',
  ]),
  d14: setor('d14', 'Automação Web', 'frota:browser-agent', [
    'Nunca submete formulário sensível sem confirmação explícita do usuário',
  ]),
  d15: setor('d15', 'Rede & Infraestrutura', 'frota:network-architect', [
    'Toda mudança de config tem plano de rollback documentado antes de aplicar',
  ]),
  d16: setor('d16', 'Growth & Marketing', 'frota:marketing-agent', [
    'Nenhuma campanha sem métrica de sucesso definida antes do lançamento',
  ]),
  d17: setor('d17', 'Meta/Processo', 'frota:agent-evaluator', [
    'Toda avaliação cita evidência concreta, nunca opinião solta',
    'Auditoria de encerramento é obrigatória ao final de cada demanda',
  ]),
  d18: setor('d18', 'Comunicação & Triagem', 'frota:chief-of-staff', [
    'Nunca envia resposta automática sem revisão para itens de ação',
  ]),
};

export function ehCategoria(valor: unknown): valor is Categoria {
  return typeof valor === 'string' && (CATEGORIAS as readonly string[]).includes(valor);
}
