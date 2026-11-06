import { ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { tenantContext } from 'src/tenancy/tenant-context';
import { TicketScheduleSettings } from 'src/tickets/entities/ticket-schedule-settings.entity';
import { Turno } from './entities/turno.entity';

export const TURNO_REQUERIDO = 'TURNO_REQUERIDO';

// Cobros por QR o alias que no son de una salida: la cuenta de un inquilino y el pase (ABONO)
// cobrado al ingresar. `alIngresar` con HORA lo ignora el servicio, así que acá tampoco exime.
export const cobroSinTurno = (dto: { tipo?: string; alIngresar?: boolean }) =>
  dto.tipo === 'INQUILINO' || (dto.tipo === 'ABONO' && dto.alIngresar === true);

// Con turnos de caja activos, el operador no registra salidas ni cobros de salida sin su turno
// abierto, con ningún medio de pago: antes solo se frenaba el efectivo, y en una playa que nunca
// había abierto un turno ni siquiera eso. Administración (ADMIN y SUPER_ADMIN) puede hacerlo sin
// turno. En modalidad gratuita no hay caja ni turnos.
//
// Se llama desde los handlers de la persona (cerrar, «Se fue antes», anticipo, descuento, QR,
// alias, abonos) y no desde la lógica de cobro: la acreditación de un QR o de una transferencia
// llega después por webhook y no puede fallar porque el operador ya cerró su turno.
export async function exigirTurnoParaSalida(ds: DataSource) {
  const scope = tenantContext.getStore();
  if (!scope?.userId || scope.role === 'ADMIN' || scope.role === 'SUPER_ADMIN') return;
  if (scope.modalidad === 'GRATUITO') return;
  const settings = await ds.getRepository(TicketScheduleSettings).findOne({ where: {} });
  if (settings?.shiftsEnabled !== true) return;
  const abierto = await ds.getRepository(Turno).exists({ where: { usuarioApertura: { id: scope.userId }, estado: 'ABIERTO' } });
  if (!abierto) throw new ForbiddenException({ code: TURNO_REQUERIDO, message: 'Abrí tu turno para registrar salidas y cobros.' });
}
