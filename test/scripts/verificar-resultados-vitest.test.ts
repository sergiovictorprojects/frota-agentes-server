import { describe, expect, it } from 'vitest';
import { conferirResultadoVitest } from '../../scripts/verificar-resultados-vitest.ts';

describe('conferirResultadoVitest', () => {
  it('aceita execução completa sem falhas', () => {
    expect(() =>
      conferirResultadoVitest({ success: true, numTotalTestSuites: 49, numFailedTestSuites: 0, numFailedTests: 0 }),
    ).not.toThrow();
  });

  it('recusa falha mesmo quando o processo do Vitest retorna zero', () => {
    expect(() =>
      conferirResultadoVitest({ success: false, numTotalTestSuites: 49, numFailedTestSuites: 27, numFailedTests: 1 }),
    ).toThrow(/Vitest reportou falhas/);
  });

  it('recusa relatório vazio, incompleto ou malformado', () => {
    expect(() => conferirResultadoVitest({ success: true, numTotalTestSuites: 0, numFailedTestSuites: 0, numFailedTests: 0 })).toThrow(
      /nenhuma suíte/,
    );
    expect(() => conferirResultadoVitest({ success: true })).toThrow(/inválido ou incompleto/);
    expect(() =>
      conferirResultadoVitest({ success: true, numTotalTestSuites: 1, numFailedTestSuites: -1, numFailedTests: 0 }),
    ).toThrow(/inválido ou incompleto/);
  });
});
