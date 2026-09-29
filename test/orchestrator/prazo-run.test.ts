import { describe, expect, it } from 'vitest';
import { criarRelogioRun, MARGEM_PERSISTENCIA_SEGUNDOS, PRAZO_RUN_SEGUNDOS } from '../../src/orchestrator/prazo-run.ts';

describe('prazo absoluto da run', () => {
  it('usa relógio monotônico e reserva margem antes de iniciar chamada', () => {
    let agora = 10_000;
    const relogio = criarRelogioRun(() => agora);
    expect(relogio.iniciouEm).toBe(agora);
    expect(relogio.podeIniciar(480)).toBe(true);
    agora += (PRAZO_RUN_SEGUNDOS - 480 - MARGEM_PERSISTENCIA_SEGUNDOS) * 1000 + 1;
    expect(relogio.podeIniciar(480)).toBe(false);
    agora += (480 + MARGEM_PERSISTENCIA_SEGUNDOS) * 1000;
    expect(relogio.restanteMs()).toBe(0);
  });
});
