import { describe, expect, it } from 'vitest';
import { agentePodeGerarArtefato, agentePodePublicarArtefato, capacidadesDoAgente } from '../../src/domain/capacidades-agentes.ts';

describe('capacidades explícitas do catálogo de agentes', () => {
  it('executor pode produzir artefato intermediário, mas não publicar a entrega final', () => {
    const capacidades = capacidadesDoAgente({ papel: 'executor' });
    expect(capacidades.gerarArtefatos).toEqual(['texto', 'json']);
    expect(capacidades.publicarArtefatos).toBe(false);
    expect(agentePodeGerarArtefato({ papel: 'executor', estado: 'ativo' }, 'texto')).toBe(true);
    expect(agentePodePublicarArtefato({ papel: 'executor', estado: 'ativo' })).toBe(false);
  });

  it('somente o coordenador ativo pode publicar e nenhum auditor gera artefato', () => {
    expect(agentePodePublicarArtefato({ papel: 'coordenador', estado: 'ativo' })).toBe(true);
    expect(agentePodePublicarArtefato({ papel: 'coordenador', estado: 'suspenso' })).toBe(false);
    expect(capacidadesDoAgente({ papel: 'auditor' }).gerarArtefatos).toEqual([]);
    expect(agentePodeGerarArtefato({ papel: 'auditor', estado: 'ativo' }, 'json')).toBe(false);
  });
});
