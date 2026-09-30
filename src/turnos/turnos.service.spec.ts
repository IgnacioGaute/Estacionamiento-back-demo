import { TurnosService } from './turnos.service';
import { Turno } from './entities/turno.entity';
import { TicketScheduleSettings } from '../tickets/entities/ticket-schedule-settings.entity';
import { User } from '../users/entities/user.entity';

describe('apertura de turnos', () => {
  it('usa el nombre del usuario autenticado e ignora el nombre y la duración enviados', async () => {
    const shifts = {
      exists: jest.fn().mockResolvedValue(false),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(value => value),
      save: jest.fn().mockImplementation(async value => value),
    };
    const manager = {
      query: jest.fn().mockResolvedValue([]),
      getRepository: jest.fn().mockImplementation(entity => {
        if (entity === Turno) return shifts;
        if (entity === TicketScheduleSettings) return { findOne: jest.fn().mockResolvedValue({ shiftsEnabled: true }) };
        if (entity === User) return { findOneBy: jest.fn().mockResolvedValue({ firstName: 'Álvaro', lastName: 'García', username: 'alvaro' }) };
        throw new Error('Repositorio inesperado');
      }),
    };
    const dataSource = { transaction: jest.fn().mockImplementation(callback => callback(manager)) };
    const service = new TurnosService(null!, null!, dataSource as never);

    const opened = await service.open('user-id', { fondoInicial: 1000, nombre: 'Otro nombre', duracionPrevistaHoras: 24 });

    expect(opened.nombre).toBe('Álvaro García');
    expect(opened.duracionPrevistaHoras).toBeNull();
  });
});
