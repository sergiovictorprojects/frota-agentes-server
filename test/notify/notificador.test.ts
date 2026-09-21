import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificadorConsole } from '../../src/notify/notificador.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NotificadorConsole', () => {
  it('escreve a notificacao como uma linha JSON no log', async () => {
    const saida = vi.spyOn(console, 'log').mockImplementation(() => {});

    await new NotificadorConsole().notificar({ nivel: 'aviso', titulo: 'Orçamento em 80%', corpo: 'Gasto: US$ 40' });

    expect(saida).toHaveBeenCalledTimes(1);
    const linha = JSON.parse(saida.mock.calls[0]![0] as string);
    expect(linha).toMatchObject({ tipo: 'notificacao', nivel: 'aviso', titulo: 'Orçamento em 80%', corpo: 'Gasto: US$ 40' });
    expect(new Date(linha.ts).toString()).not.toBe('Invalid Date');
  });
});
