import { describe, expect, it } from 'vitest';
import { CATEGORIAS, ehCategoria, SETORES } from '../../src/domain/setores.ts';

describe('SETORES', () => {
  it('cobre todas as categorias com id coerente', () => {
    for (const c of CATEGORIAS) {
      expect(SETORES[c].id).toBe(c);
    }
    expect(Object.keys(SETORES)).toHaveLength(CATEGORIAS.length);
  });

  it('usa o namespace proprio frota:* e nunca ecc:, ruflo: ou od:', () => {
    for (const s of Object.values(SETORES)) {
      expect(s.papel).toMatch(/^frota:[a-z-]+$/);
    }
  });

  it('tem papeis unicos', () => {
    const papeis = Object.values(SETORES).map((s) => s.papel);
    expect(new Set(papeis).size).toBe(papeis.length);
  });

  it('exige ao menos uma regra auditavel por setor', () => {
    for (const s of Object.values(SETORES)) {
      expect(s.regras.length).toBeGreaterThan(0);
      for (const r of s.regras) expect(r.trim().length).toBeGreaterThan(0);
    }
  });

  it('impede entrega HTML em setores somente-leitura e de delegacao', () => {
    expect(SETORES.d2.podeEntregarHtml).toBe(false);
    expect(SETORES.gestores.podeEntregarHtml).toBe(false);
    expect(SETORES.d1.podeEntregarHtml).toBe(true);
  });

  it('separa em regras distintas as clausulas que o Organograma junta com "·"', () => {
    expect(SETORES.d3.regras).toHaveLength(2);
    expect(SETORES.d6.regras).toHaveLength(2);
    expect(SETORES.d17.regras).toHaveLength(2);
  });
});

describe('ehCategoria', () => {
  it('aceita ids validos e rejeita o resto', () => {
    expect(ehCategoria('d18')).toBe(true);
    expect(ehCategoria('gestores')).toBe(true);
    expect(ehCategoria('d19')).toBe(false);
    expect(ehCategoria(42)).toBe(false);
    expect(ehCategoria(undefined)).toBe(false);
  });
});
