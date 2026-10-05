import { TurnosService } from './turnos.service';
import { Turno } from './entities/turno.entity';
import { TicketScheduleSettings } from '../tickets/entities/ticket-schedule-settings.entity';
describe('turno del usuario autenticado', () => {
  it('rechaza una segunda apertura del mismo usuario antes de tocar el fondo', async () => {
    const shifts = { exists: jest.fn().mockResolvedValue(true) };
    const manager = { query: jest.fn(), getRepository: jest.fn(entity => entity === Turno ? shifts : null) };
    const ds = { transaction: jest.fn(fn => fn(manager)) };
    const service = new TurnosService(null!, null!, ds as never);
    await expect(service.open('usuario', { fondoInicial: 0 })).rejects.toThrow('Ya tenés un turno abierto');
    expect(shifts.exists).toHaveBeenCalledWith({ where: { usuarioApertura: { id: 'usuario' }, estado: 'ABIERTO' } });
  });
  it('rechaza abrir cuando los turnos están apagados', async () => {
    const manager = { query: jest.fn(), getRepository: jest.fn(entity => entity === Turno ? { exists: jest.fn().mockResolvedValue(false) } : entity === TicketScheduleSettings ? { findOne: jest.fn().mockResolvedValue({ shiftsEnabled: false }) } : null) };
    const ds = { transaction: jest.fn(fn => fn(manager)) };
    await expect(new TurnosService(null!, null!, ds as never).open('usuario', { fondoInicial: 0 })).rejects.toThrow('Los turnos están desactivados');
  });
});
