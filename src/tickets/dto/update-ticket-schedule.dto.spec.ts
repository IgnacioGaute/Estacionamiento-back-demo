import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateTicketScheduleDto } from './update-ticket-schedule.dto';

describe('sueldos por usuario', () => {
  const usuarioId = '00000000-0000-4000-8000-000000000001';
  it.each([null, [{ usuarioId, importe: 0 }], [{ usuarioId, importe: -1 }], [{ usuarioId, importe: 1.5 }], [{ usuarioId, importe: 100000001 }], [{ usuarioId: 'otro', importe: 10 }], [{ usuarioId, importe: 10 }, { usuarioId, importe: 20 }]].map(value => ({ value })))('rechaza la configuración inválida $value', async ({ value: sueldosPorUsuario }) => {
    expect(await validate(plainToInstance(UpdateTicketScheduleDto, { sueldosPorUsuario }))).not.toHaveLength(0);
  });
  it.each([[], [{ usuarioId, importe: 25000 }]].map(value => ({ value })))('admite usuarios seleccionados o ninguno: $value', async ({ value: sueldosPorUsuario }) => {
    expect(await validate(plainToInstance(UpdateTicketScheduleDto, { sueldosPorUsuario }))).toHaveLength(0);
  });
});
