// Modo da orquestração por tarefas (ORQUESTRACAO_TAREFAS). Nesta entrega (Fase 3.1) só existem "desligada"
// (padrão: nada muda) e "planejar" (o plano é proposto, validado e gravado, mas nunca executado).
export const MODOS_ORQUESTRACAO = ['desligada', 'planejar'] as const;
export type ModoOrquestracao = (typeof MODOS_ORQUESTRACAO)[number];
