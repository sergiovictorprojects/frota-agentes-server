// Relógio monotônico para o prazo absoluto da run. O relógio de parede é adequado para persistir datas,
// mas não para decidir se uma execução pode começar: ajustes de NTP poderiam criar tempo negativo ou
// permitir uma chamada depois do limite.
export const PRAZO_RUN_SEGUNDOS = 50 * 60;
export const MARGEM_PERSISTENCIA_SEGUNDOS = 2 * 60;

export interface RelogioRun {
  iniciouEm: number;
  agora(): number;
  restanteMs(): number;
  podeIniciar(timeoutSegundos: number): boolean;
}

export function criarRelogioRun(
  agoraMonotono: () => number = () => performance.now(),
  prazoSegundos = PRAZO_RUN_SEGUNDOS,
): RelogioRun {
  const iniciouEm = agoraMonotono();
  const limite = iniciouEm + prazoSegundos * 1000;
  return {
    iniciouEm,
    agora: agoraMonotono,
    restanteMs: () => Math.max(0, limite - agoraMonotono()),
    podeIniciar: (timeoutSegundos) => limite - agoraMonotono() >= (timeoutSegundos + MARGEM_PERSISTENCIA_SEGUNDOS) * 1000,
  };
}

export class PrazoRunExcedidoError extends Error {
  constructor() {
    super('O prazo absoluto da run não permite iniciar outra chamada.');
    this.name = 'PrazoRunExcedidoError';
  }
}
