jest.mock('./turno-book', () => ({ ...jest.requireActual('./turno-book'), rolloverShifts: jest.fn(async () => undefined) }));
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

  it('permite al superadministrador revisar el turno de otro operador', async () => {
    const repo = { findOne: jest.fn().mockResolvedValue({ usuarioApertura: { id: 'operador', firstName: 'Ana' } }) };
    const ds = { query: jest.fn().mockResolvedValue([]) };
    const service = new TurnosService(repo as never, null!, ds as never);
    await expect(service.estadiasAbiertas('turno', 'super', 'SUPER_ADMIN', true)).resolves.toEqual([]);
    await expect(service.estadiasAbiertas('turno', 'otro', 'USER', true)).rejects.toThrow('Solo el responsable');
  });

  it('el cierre de otro operador por superadministrador sigue exigiendo un motivo', async () => {
    const repo = { findOne: jest.fn().mockResolvedValue({ id: 'turno', usuarioApertura: { id: 'operador' } }) };
    const manager = { query: jest.fn(), getRepository: jest.fn(() => repo) };
    const ds = { transaction: jest.fn(fn => fn(manager)) };
    const service = new TurnosService(repo as never, null!, ds as never);
    await expect(service.close('turno', 'super', {} as never, 'SUPER_ADMIN')).rejects.toThrow('Explicá por qué cerrás');
    await expect(service.close('turno', 'otro', {} as never, 'USER')).rejects.toThrow('El cierre debe confirmarlo');
  });
});
