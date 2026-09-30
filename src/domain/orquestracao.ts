// Modo da orquestração por tarefas (ORQUESTRACAO_TAREFAS). "executar" só é aceito junto de uma categoria
// piloto explícita; demandas fora dela continuam no fluxo legado.
export const MODOS_ORQUESTRACAO = ['desligada', 'planejar', 'executar'] as const;
export type ModoOrquestracao = (typeof MODOS_ORQUESTRACAO)[number];
