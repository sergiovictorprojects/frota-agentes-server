import { describe, expect, it } from 'vitest';
import {
  agentePodeGerarArtefatoEntregavel,
  agentePodeGerarArtefatoIntermediario,
  agentePodePublicarArtefato,
  capacidadesPadraoDoAgente,
} from '../../src/domain/capacidades-agentes.ts';

describe('capacidades explícitas do catálogo de agentes', () => {
  it('separa artefato intermediário dos formatos finais da especialidade', () => {
    const capacidades = capacidadesPadraoDoAgente({ categoria: 'd10', papel: 'executor' });
    expect(capacidades.gerarArtefatos).toContain('xlsx');
    expect(capacidades.gerarArtefatos).not.toContain('svg');
    expect(capacidades.publicarArtefatos).toBe(false);
    expect(agentePodeGerarArtefatoIntermediario({ papel: 'executor', estado: 'ativo' }, 'texto')).toBe(true);
    expect(agentePodeGerarArtefatoEntregavel({ estado: 'ativo', capacidades }, 'xlsx')).toBe(true);
    expect(agentePodePublicarArtefato({ estado: 'ativo', capacidades })).toBe(false);
  });

  it('somente o coordenador ativo publica e auditor não gera arquivos', () => {
    const coordenador = capacidadesPadraoDoAgente({ categoria: 'gestores', papel: 'coordenador' });
    const auditor = capacidadesPadraoDoAgente({ categoria: 'd17', papel: 'auditor' });
    expect(agentePodePublicarArtefato({ estado: 'ativo', capacidades: coordenador })).toBe(true);
    expect(agentePodePublicarArtefato({ estado: 'suspenso', capacidades: coordenador })).toBe(false);
    expect(auditor.gerarArtefatos).toEqual([]);
    expect(agentePodeGerarArtefatoIntermediario({ papel: 'auditor', estado: 'ativo' }, 'json')).toBe(false);
  });

  it('design e dados recebem matrizes diferentes e leitura de anexos segue desligada', () => {
    const design = capacidadesPadraoDoAgente({ categoria: 'd11', papel: 'executor' });
    const dados = capacidadesPadraoDoAgente({ categoria: 'd10', papel: 'executor' });
    expect(design.gerarArtefatos).toEqual(['pdf', 'pptx', 'html', 'svg', 'zip']);
    expect(dados.gerarArtefatos).toContain('csv');
    expect(design.lerAnexos).toBe(false);
    expect(dados.lerAnexos).toBe(false);
  });
});
