import { ConflictException } from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { TicketRegistration } from './entities/ticket-registration.entity';

// La salida de una estadía que ingresó gratis: sin tarifa, movimientos ni caja, idempotente, y
// liberando la tarjeta. Con PostgreSQL real (concurrencia, RLS, sin filas de caja) lo cubre
// test/modalidad.integration.cjs.

function setup(registration: Partial<TicketRegistration>, ticket: { codeBar: string; vehicleType: string } | null = null) {
  const fila = { id: 'r1', entryDay: '2026-10-19', entryTime: '10:00:00', departureTime: null, departureDay: null, vehicleType: 'AUTO', pricingSnapshot: null, ...registration } as TicketRegistration;
  const repository = {
    findOne: jest.fn(async ({ relations }: { relations?: string[] }) => (relations ? { ...fila, ticket } : fila)),
    save: jest.fn(async (r: TicketRegistration) => r),
  };
  const turno = { findOne: jest.fn().mockResolvedValue(null), createQueryBuilder: jest.fn() };
  const usuario = { findOne: jest.fn().mockResolvedValue({ firstName: 'Ana', lastName: 'Pérez', username: 'ana' }) };
  const manager = {
    query: jest.fn().mockResolvedValue([]),
    getRepository: jest.fn((entity: { name: string }) => (entity.name === 'TicketRegistration' ? repository : entity.name === 'Turno' ? { ...turno, createQueryBuilder: () => ({ leftJoinAndSelect: () => ({ where: () => ({ getMany: async () => [] }) }) }) } : usuario)),
  };
  const movimientos = { create: jest.fn(), sumByRegistration: jest.fn() };
  const boxes = { applyTicketPayment: jest.fn() };
  const gateway = { emitNewRegistration: jest.fn() };
  const service = Object.create(TicketsService.prototype) as TicketsService;
  Object.assign(service, {
    dataSource: { transaction: (callback: (m: unknown) => Promise<unknown>) => callback(manager) },
    ticketRegistrationRepository: repository,
    movimientosService: movimientos,
    boxListsService: boxes,
    ticketGateway: gateway,
  });
  return { service, fila, repository, movimientos, boxes, gateway };
}

describe('Salida de una estadía gratuita', () => {
  test('registra la salida y el operador sin tarifa, movimientos ni caja, y libera la tarjeta', async () => {
    const { service, repository, movimientos, boxes, gateway } = setup({ modalidad: 'GRATUITO', entryMode: 'BARCODE' }, { codeBar: 'T-01', vehicleType: 'AUTO' });
    const saved = await service.registrarSalidaGratuita('r1', 'u1');
    expect(saved.departureDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(saved.departureTime).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(saved.exitOperatorName).toBe('Ana Pérez');
    expect(saved.ticket).toBeNull();
    expect(saved.codeBarTicket).toBe('T-01');
    expect(saved.price).toBeUndefined();
    expect(saved.pricingBreakdown).toBeUndefined();
    expect(movimientos.create).not.toHaveBeenCalled();
    expect(boxes.applyTicketPayment).not.toHaveBeenCalled();
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(gateway.emitNewRegistration).toHaveBeenCalledTimes(1);
  });

  test('reintentar devuelve la misma salida sin guardar ni avisar de nuevo', async () => {
    const { service, repository, gateway } = setup({ modalidad: 'GRATUITO', departureDay: '2026-10-19', departureTime: '11:00:00' });
    const saved = await service.registrarSalidaGratuita('r1', 'u1');
    expect(saved.departureTime).toBe('11:00:00');
    expect(repository.save).not.toHaveBeenCalled();
    expect(gateway.emitNewRegistration).not.toHaveBeenCalled();
  });

  test('una estadía con cobro no sale por acá', async () => {
    const { service, repository } = setup({ modalidad: 'CON_COBRO' });
    const error = await service.registrarSalidaGratuita('r1', 'u1').catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ code: 'ESTADIA_CON_COBRO' });
    expect(repository.save).not.toHaveBeenCalled();
  });

  test('una estadía gratuita no tiene importes: el resumen de cobro, el anticipo y el cierre con cobro la rechazan', async () => {
    const { service, movimientos } = setup({ modalidad: 'GRATUITO' });
    for (const intento of [
      () => service.getCloseSummary('r1'),
      () => service.previewPlannedPrice('r1', 60),
      () => service.addAdvancePayment('r1', { advancePaidAmount: 500, metodo: 'CASH' } as never, 'u1'),
      () => service.closeRegistrationByPlate('r1', { closeType: 'NO_CHARGE', expectedPrice: 0, expectedCollected: 0 } as never, 'u1'),
    ]) {
      const error = await intento().catch((e) => e);
      expect(error.getResponse?.()).toMatchObject({ code: 'ESTADIA_GRATUITA' });
    }
    expect(movimientos.create).not.toHaveBeenCalled();
  });

  test('el panel de salida recibe la estadía gratuita sin importes', async () => {
    const { service } = setup({ modalidad: 'GRATUITO' });
    const resumen = await service.getResumenSalida('r1');
    expect(resumen).toMatchObject({ modalidad: 'GRATUITO' });
    expect(resumen).not.toHaveProperty('saldoACobrar');
    expect(resumen).not.toHaveProperty('previewBracket');
    expect(typeof resumen.elapsedMinutes).toBe('number');
  });
});
