import { TicketsService } from './tickets.service';
import { TicketRegistration } from './entities/ticket-registration.entity';
import { defaultPricingOptions, PricingSnapshot } from './pricing/pricing.types';

const snapshot: PricingSnapshot = {
  version: 1,
  capturedAt: '2026-09-18T13:00:00.000Z',
  schedule: { dayStartHour: 8, dayEndHour: 20, graceMinutes: 0, pricingDayTypeBasis: 'ENTRY', pricingOptions: defaultPricingOptions() },
  brackets: [{ id: 'one-hour', vehicleType: 'AUTO', ticketDayType: null, label: 'Una hora', uptoMinutes: 60, price: 600, recurringUnitMinutes: null }],
};

function setup(collected: number) {
  const registration = {
    id: 'registration-id', entryDay: '2026-09-18', entryTime: '10:00:00', departureTime: null,
    vehicleType: 'AUTO', pricingSnapshot: snapshot, advancePaidAmount: collected,
  } as TicketRegistration;
  const repository = { findOne: jest.fn().mockResolvedValue(registration), save: jest.fn().mockResolvedValue(registration) };
  const manager = { getRepository: jest.fn().mockReturnValue(repository) };
  const createMovement = jest.fn().mockResolvedValue({});
  const service = Object.create(TicketsService.prototype) as TicketsService;
  Object.assign(service, {
    dataSource: { transaction: (callback: (manager: unknown) => Promise<unknown>) => callback(manager) },
    ticketRegistrationRepository: repository,
    movimientosService: { sumByRegistration: jest.fn().mockResolvedValue(collected), create: createMovement },
    boxListsService: { applyTicketPayment: jest.fn().mockResolvedValue({ id: 'box' }) },
    ticketGateway: { emitNewRegistration: jest.fn() },
  });
  return { service, registration, createMovement };
}

describe('Cobro completo de estadía planificada', () => {
  it('muestra y cobra el precio fijado al ingresar, descontando lo ya cobrado', async () => {
    const { service, registration, createMovement } = setup(200);
    await expect(service.previewPlannedPrice(registration.id, 60)).resolves.toMatchObject({ price: 600, ticketDayType: 'DAY' });
    await service.addAdvancePayment(registration.id, {
      chargeFullPlannedStay: true, expectedUptoMinutes: 60, expectedBracketLabel: 'Una hora', metodo: 'CASH',
    }, 'operator-id');
    expect(createMovement).toHaveBeenCalledWith(expect.objectContaining({ monto: 400, tipo: 'ANTICIPO', metodo: 'CASH' }), expect.anything());
    expect(registration.advancePaidAmount).toBe(600);
  });

  it('rechaza cobrar una tarifa inferior al anticipo existente', async () => {
    const { service, registration, createMovement } = setup(700);
    await expect(service.addAdvancePayment(registration.id, {
      chargeFullPlannedStay: true, expectedUptoMinutes: 60, metodo: 'CASH',
    }, 'operator-id')).rejects.toThrow('Ya se cobró más que esta tarifa');
    expect(createMovement).not.toHaveBeenCalled();
  });

  it('guarda la duración sin generar cobro cuando se paga al salir', async () => {
    const { service, registration, createMovement } = setup(0);
    await service.addAdvancePayment(registration.id, {
      chargeFullPlannedStay: false, expectedUptoMinutes: 60, expectedBracketLabel: 'Una hora',
    }, 'operator-id');
    expect(registration.expectedUptoMinutes).toBe(60);
    expect(createMovement).not.toHaveBeenCalled();
  });
});
