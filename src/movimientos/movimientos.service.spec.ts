import { BadRequestException } from '@nestjs/common';
import { MovimientosService } from './movimientos.service';
import { Movimiento } from './entities/movimiento.entity';

// Repositorio en memoria: create devuelve lo que recibe y save lo guarda en `guardados`.
const repositorio = (filas: Partial<Movimiento>[] = []) => {
  const guardados: Partial<Movimiento>[] = [];
  return {
    guardados,
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => { guardados.push(value); return value; }),
    find: jest.fn(async () => filas),
  };
};

const armar = (turnoAbierto: { id: string } | null = null) => {
  const repo = repositorio();
  const turnos = { findOpenTurnoOrNull: jest.fn(async () => turnoAbierto) };
  const service = new MovimientosService(repo as never, turnos as never);
  return { repo, turnos, service };
};

const cobro = { monto: 1000, metodo: 'CASH' as const, usuarioId: 'user-1', ticketRegistrationId: 'reg-1' };

describe('Libro de movimientos', () => {
  describe('motivo obligatorio', () => {
    test.each([
      ['AJUSTE', undefined],
      ['AJUSTE', '   '],
      ['CORTESIA', undefined],
      ['CORTESIA', ''],
    ] as const)('%s sin motivo (%p) se rechaza y no se guarda nada', async (tipo, motivo) => {
      const { repo, turnos, service } = armar();
      await expect(service.create({ ...cobro, tipo, motivo })).rejects.toThrow(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
      expect(turnos.findOpenTurnoOrNull).not.toHaveBeenCalled();
    });

    test.each(['ANTICIPO', 'SALDO'] as const)('%s no necesita motivo', async (tipo) => {
      const { repo, service } = armar();
      await service.create({ ...cobro, tipo });
      expect(repo.guardados).toHaveLength(1);
      expect(repo.guardados[0]).toEqual(expect.objectContaining({ tipo, monto: 1000, motivo: null }));
    });

    test('un ajuste con motivo se guarda con su motivo', async () => {
      const { repo, service } = armar();
      await service.create({ ...cobro, tipo: 'AJUSTE', monto: -500, motivo: 'Devolución por error de tarifa' });
      expect(repo.guardados[0]).toEqual(expect.objectContaining({ monto: -500, motivo: 'Devolución por error de tarifa' }));
    });
  });

  describe('a qué turno va el movimiento', () => {
    test('sin indicarlo, al turno abierto; si no hay, queda sin turno en vez de bloquear el cobro', async () => {
      const conTurno = armar({ id: 'turno-1' });
      await conTurno.service.create({ ...cobro, tipo: 'SALDO' });
      expect(conTurno.turnos.findOpenTurnoOrNull).toHaveBeenCalledWith('user-1', undefined);
      expect(conTurno.repo.guardados[0].turno).toEqual({ id: 'turno-1' });

      const sinTurno = armar(null);
      await sinTurno.service.create({ ...cobro, tipo: 'SALDO' });
      expect(sinTurno.repo.guardados[0].turno).toBeNull();
    });

    test('un turno indicado (cobro offline) manda sobre el abierto, y null lo deja sin turno', async () => {
      const { repo, turnos, service } = armar({ id: 'turno-abierto' });
      await service.create({ ...cobro, tipo: 'SALDO' }, undefined, 'turno-del-corte');
      await service.create({ ...cobro, tipo: 'SALDO' }, undefined, null);
      expect(turnos.findOpenTurnoOrNull).not.toHaveBeenCalled();
      expect(repo.guardados.map((m) => m.turno)).toEqual([{ id: 'turno-del-corte' }, null]);
    });
  });

  test('dentro de una transacción guarda con el repositorio de esa transacción', async () => {
    const { repo, service } = armar();
    const repoTransaccion = repositorio();
    const manager = { getRepository: jest.fn(() => repoTransaccion) };
    await service.create({ ...cobro, tipo: 'SALDO' }, manager as never);
    expect(manager.getRepository).toHaveBeenCalledWith(Movimiento);
    expect(repoTransaccion.guardados).toHaveLength(1);
    expect(repo.save).not.toHaveBeenCalled();
  });

  test('lo cobrado suma anticipos, saldos y ajustes, pero no cortesías', async () => {
    const repo = repositorio([
      { tipo: 'ANTICIPO', monto: 1500 },
      { tipo: 'SALDO', monto: 2000 },
      { tipo: 'AJUSTE', monto: -500 },
      { tipo: 'CORTESIA', monto: 1000 },
    ]);
    const service = new MovimientosService(repo as never, {} as never);
    expect(await service.sumByRegistration('reg-1')).toBe(3000);
  });
});
