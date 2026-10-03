import { describe, expect, it } from 'vitest';
import { estimarUsoDemanda } from '../../src/domain/estimativa-demanda.ts';

describe('estimarUsoDemanda', () => {
  it('aumenta chamadas, tokens e orcamento conforme a complexidade', () => {
    const baixa = estimarUsoDemanda({ complexidade: 'LOW', resultadoEsperado: 'outro', categoria: 'd1' });
    const media = estimarUsoDemanda({ complexidade: 'MEDIUM', resultadoEsperado: 'outro', categoria: 'd1' });
    const alta = estimarUsoDemanda({ complexidade: 'HIGH', resultadoEsperado: 'outro', categoria: 'd1' });

    expect(baixa.chamadasLlmMax).toBeLessThan(media.chamadasLlmMax);
    expect(media.chamadasLlmMax).toBeLessThan(alta.chamadasLlmMax);
    expect(baixa.tokensTotaisEstimados).toBeLessThan(media.tokensTotaisEstimados);
    expect(media.tokensTotaisEstimados).toBeLessThan(alta.tokensTotaisEstimados);
    expect(Number(baixa.orcamentoSugeridoUsd)).toBeLessThan(Number(media.orcamentoSugeridoUsd));
    expect(Number(media.orcamentoSugeridoUsd)).toBeLessThan(Number(alta.orcamentoSugeridoUsd));
  });

  it('interface adiciona margem operacional sem chamar API', () => {
    const livre = estimarUsoDemanda({ complexidade: 'MEDIUM', resultadoEsperado: 'outro', categoria: 'd11' });
    const interfaceHtml = estimarUsoDemanda({
      complexidade: 'MEDIUM',
      resultadoEsperado: 'interface',
      categoria: 'd11',
      descricao: 'Dashboard com filtros, cards e ações interativas.',
      criteriosAceite: 'Entregar HTML funcional.',
    });

    expect(interfaceHtml.chamadasLlmMax).toBeGreaterThan(livre.chamadasLlmMax);
    expect(interfaceHtml.tokensTotaisEstimados).toBeGreaterThan(livre.tokensTotaisEstimados);
    expect(Number(interfaceHtml.orcamentoSugeridoUsd)).toBeGreaterThan(Number(livre.orcamentoSugeridoUsd));
    expect(interfaceHtml.modeloReferencia).toBe('claude-sonnet-5');
  });
});
