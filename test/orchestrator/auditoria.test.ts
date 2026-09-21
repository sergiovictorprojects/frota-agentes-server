import { describe, expect, it } from 'vitest';
import { SETORES } from '../../src/domain/setores.ts';
import { calcularAuditoria, casarRegra, indiceGeral, regrasDosSetores } from '../../src/orchestrator/auditoria.ts';

const REGRA_D1 = SETORES.d1.regras[0]!;
const [REGRA_D3_A, REGRA_D3_B] = SETORES.d3.regras as [string, string];
const EVIDENCIA = 'Nenhuma alternativa foi comparada no texto entregue';

const violacao = (regra: string, evidencia = EVIDENCIA, gravidade: 'HIGH' | 'LOW' = 'HIGH') => ({
  regra,
  evidencia,
  gravidade,
});

describe('regrasDosSetores', () => {
  it('junta as regras dos setores sem repetir', () => {
    expect(regrasDosSetores(['d1', 'd1', 'd3'])).toEqual([REGRA_D1, REGRA_D3_A, REGRA_D3_B]);
  });

  it('devolve lista vazia sem setores', () => {
    expect(regrasDosSetores([])).toEqual([]);
  });
});

describe('casarRegra', () => {
  it('aceita a regra literal, com outra caixa ou pontuacao, e trechos dela', () => {
    expect(casarRegra(REGRA_D1, [REGRA_D1])).toBe(REGRA_D1);
    expect(casarRegra(REGRA_D1.toUpperCase() + '.', [REGRA_D1])).toBe(REGRA_D1);
    expect(casarRegra('Toda decisão de arquitetura registra alternativas', [REGRA_D1])).toBe(REGRA_D1);
  });

  it('rejeita regra inexistente e textos curtos demais para serem uma citacao', () => {
    expect(casarRegra('Regra que não existe em nenhum setor', [REGRA_D1])).toBeNull();
    expect(casarRegra('regra', [REGRA_D1])).toBeNull();
  });
});

describe('calcularAuditoria', () => {
  const regras = [REGRA_D1, REGRA_D3_A, REGRA_D3_B];

  it('sem violacoes: 0 antipadroes e 100% de regras cumpridas', () => {
    const r = calcularAuditoria(regras, { violacoes: [], observacoes: 'ok' });
    expect(r).toMatchObject({ antipadroesCount: 0, regrasCumpridasPercent: 100, violacoes: [] });
  });

  it('calcula o percentual pelas regras distintas violadas', () => {
    const r = calcularAuditoria(regras, { violacoes: [violacao(REGRA_D1)], observacoes: '' });
    expect(r.antipadroesCount).toBe(1);
    expect(r.regrasCumpridasPercent).toBe(67);
  });

  it('conta duas evidencias diferentes da mesma regra como dois antipadroes, mas uma regra violada', () => {
    const r = calcularAuditoria(regras, {
      violacoes: [violacao(REGRA_D1, 'Primeiro trecho problemático da entrega'), violacao(REGRA_D1, 'Segundo trecho problemático da entrega')],
      observacoes: '',
    });
    expect(r.antipadroesCount).toBe(2);
    expect(r.regrasCumpridasPercent).toBe(67);
  });

  it('ignora violacao repetida, de regra desconhecida ou sem evidencia concreta', () => {
    const r = calcularAuditoria(regras, {
      violacoes: [
        violacao(REGRA_D1),
        violacao(REGRA_D1),
        violacao('Uma regra inventada que não está em vigor'),
        violacao(REGRA_D3_A, 'curta'),
      ],
      observacoes: '',
    });
    expect(r.antipadroesCount).toBe(1);
    expect(r.violacoes).toHaveLength(1);
    expect(r.regrasCumpridasPercent).toBe(67);
    // repetida nao conta como descartada; regra inventada e evidencia curta contam
    expect(r.violacoesDescartadas).toBe(2);
  });

  it('reconhece a regra citada com reticencias ou pontuacao a mais', () => {
    const r = calcularAuditoria(regras, {
      violacoes: [violacao(`“${REGRA_D1.slice(0, 40)}…”`)],
      observacoes: '',
    });
    expect(r.violacoes).toHaveLength(1);
    expect(r.violacoesDescartadas).toBe(0);
  });

  it('reconhece a regra citada com variacao de caixa', () => {
    const r = calcularAuditoria(regras, { violacoes: [violacao(REGRA_D1.toLowerCase())], observacoes: '' });
    expect(r.violacoes[0]?.regra).toBe(REGRA_D1);
  });

  it('chega a 0% quando todas as regras foram violadas', () => {
    const r = calcularAuditoria(regras, {
      violacoes: regras.map((regra) => violacao(regra)),
      observacoes: '',
    });
    expect(r.regrasCumpridasPercent).toBe(0);
    expect(r.antipadroesCount).toBe(3);
  });

  it('nao divide por zero quando nao ha regras', () => {
    expect(calcularAuditoria([], { violacoes: [], observacoes: '' }).regrasCumpridasPercent).toBe(100);
  });
});

describe('indiceGeral', () => {
  it('pondera igualmente a autoavaliacao e a conformidade auditada', () => {
    expect(indiceGeral(90, 100)).toBe(95);
    expect(indiceGeral(100, 50)).toBe(75);
    expect(indiceGeral(0, 0)).toBe(0);
    expect(indiceGeral(90, 0)).toBe(45);
  });
});
