import { BoxListsService } from '../box-lists/box-lists.service';
import { MovimientosService } from '../movimientos/movimientos.service';
import { BoxList } from '../box-lists/entities/box-list.entity';
import { CashEntry } from '../turnos/entities/cash-entry.entity';
import { Turno } from '../turnos/entities/turno.entity';
import { TicketScheduleSettings } from './entities/ticket-schedule-settings.entity';
import { Movimiento } from '../movimientos/entities/movimiento.entity';

describe('sincronización de cobros de un turno', () => {
  it('registra el efectivo en el turno capturado durante el corte', async () => {
    const cash = { save: jest.fn().mockResolvedValue({}) };
    const shift = { findOne: jest.fn().mockResolvedValue({ id: 'turno-del-corte' }) };
    const settings = { findOne: jest.fn().mockResolvedValue({ shiftsEnabled: true }) };
    const boxes = {
      findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
      create: jest.fn().mockImplementation(value => value),
      save: jest.fn().mockResolvedValue({ id: 'caja-del-dia', boxNumber: 1, totalPrice: 1500 }),
    };
    const manager = {
      query: jest.fn().mockResolvedValue([]),
      getRepository: jest.fn().mockImplementation(entity => {
        if (entity === BoxList) return boxes;
        if (entity === CashEntry) return cash;
        if (entity === Turno) return shift;
        if (entity === TicketScheduleSettings) return settings;
        throw new Error('Repositorio inesperado');
      }),
    };
    const service = new BoxListsService(null!, null!, null!);

    await service.applyTicketPayment('2026-09-29', 1500, manager as never, 'turno-del-corte');

    expect(shift.findOne).toHaveBeenCalledWith({ where: { id: 'turno-del-corte', estado: 'ABIERTO', cashVersion: 2 } });
    expect(cash.save).toHaveBeenCalledWith(expect.objectContaining({ amount: 1500, turnoId: 'turno-del-corte' }));
  });

  it('no asigna un cobro a otro turno si el original ya cerró', async () => {
    const cash = { save: jest.fn() };
    const shift = { findOne: jest.fn().mockResolvedValue(null) };
    const boxes = {
      findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
      create: jest.fn().mockImplementation(value => value),
      save: jest.fn().mockResolvedValue({ id: 'caja-del-dia', boxNumber: 1, totalPrice: 1500 }),
    };
    const manager = {
      query: jest.fn().mockResolvedValue([]),
      getRepository: jest.fn().mockImplementation(entity => entity === BoxList ? boxes : entity === Turno ? shift : cash),
    };
    const service = new BoxListsService(null!, null!, null!);

    await expect(service.applyTicketPayment('2026-09-29', 1500, manager as never, 'turno-cerrado'))
      .rejects.toThrow('El turno del cobro ya no está abierto.');
    expect(cash.save).not.toHaveBeenCalled();
  });

  it('registra en caja diaria sin turno cuando el corte comenzó sin uno abierto', async () => {
    const cash = { save: jest.fn().mockResolvedValue({}) };
    const shift = { findOne: jest.fn(), exists: jest.fn() };
    const settings = { findOne: jest.fn().mockResolvedValue({ shiftsEnabled: true }) };
    const boxes = {
      findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
      create: jest.fn().mockImplementation(value => value),
      save: jest.fn().mockResolvedValue({ id: 'caja-del-dia', boxNumber: 1, totalPrice: 1500 }),
    };
    const manager = {
      query: jest.fn().mockResolvedValue([]),
      getRepository: jest.fn().mockImplementation(entity => {
        if (entity === BoxList) return boxes;
        if (entity === CashEntry) return cash;
        if (entity === Turno) return shift;
        if (entity === TicketScheduleSettings) return settings;
        throw new Error('Repositorio inesperado');
      }),
    };
    const service = new BoxListsService(null!, null!, null!);

    await service.applyTicketPayment('2026-09-29', 1500, manager as never, null);

    expect(shift.findOne).not.toHaveBeenCalled();
    expect(cash.save).toHaveBeenCalledWith(expect.objectContaining({ amount: 1500, turnoId: null }));
  });

  it('asigna el movimiento al turno capturado, aunque haya otro abierto', async () => {
    const findOpen = jest.fn();
    const movements = {
      create: jest.fn().mockImplementation(value => value),
      save: jest.fn().mockImplementation(async value => value),
    };
    const manager = { getRepository: jest.fn().mockImplementation(entity => entity === Movimiento ? movements : null) };
    const service = new MovimientosService(null!, { findOpenTurnoOrNull: findOpen } as never);

    await service.create({ usuarioId: 'operador', monto: 1500, metodo: 'CASH', tipo: 'SALDO' } as never, manager as never, 'turno-del-corte');

    expect(findOpen).not.toHaveBeenCalled();
    expect(movements.create).toHaveBeenCalledWith(expect.objectContaining({ turno: { id: 'turno-del-corte' } }));
  });

  it('deja el movimiento sin turno cuando no había uno al comenzar el corte', async () => {
    const findOpen = jest.fn();
    const movements = {
      create: jest.fn().mockImplementation(value => value),
      save: jest.fn().mockImplementation(async value => value),
    };
    const manager = { getRepository: jest.fn().mockImplementation(entity => entity === Movimiento ? movements : null) };
    const service = new MovimientosService(null!, { findOpenTurnoOrNull: findOpen } as never);

    await service.create({ usuarioId: 'operador', monto: 1500, metodo: 'CASH', tipo: 'SALDO' } as never, manager as never, null);

    expect(findOpen).not.toHaveBeenCalled();
    expect(movements.create).toHaveBeenCalledWith(expect.objectContaining({ turno: null }));
  });
});
