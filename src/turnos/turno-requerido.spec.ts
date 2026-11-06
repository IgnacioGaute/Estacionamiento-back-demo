import { ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { tenantContext, TenantScope } from 'src/tenancy/tenant-context';
import { TicketScheduleSettings } from 'src/tickets/entities/ticket-schedule-settings.entity';
import { cobroSinTurno, exigirTurnoParaSalida, TURNO_REQUERIDO } from './turno-requerido';
import { CobrosMercadoPagoController } from 'src/mercadopago/cobros.controller';
import { VerificacionAliasController } from 'src/mercadopago/verificacion-alias.controller';

// Turnos activos o no, y si el usuario tiene su turno abierto.
function fuente(shiftsEnabled: boolean | null, abierto: boolean) {
  const settings = { findOne: jest.fn().mockResolvedValue(shiftsEnabled === null ? null : { shiftsEnabled }) };
  const turnos = { exists: jest.fn().mockResolvedValue(abierto) };
  const ds = { getRepository: jest.fn((entidad: unknown) => (entidad === TicketScheduleSettings ? settings : turnos)) };
  return { ds: ds as unknown as DataSource, settings, turnos };
}
const sesion = (role: string, modalidad: TenantScope['modalidad'] = 'CON_COBRO'): TenantScope =>
  ({ empresaId: 'empresa', playaId: 'playa', userId: 'usuario', role, modalidad });
const en = (scope: TenantScope, ds: DataSource) => tenantContext.run(scope, () => exigirTurnoParaSalida(ds));

describe('exigirTurnoParaSalida', () => {
  test('el operador sin turno abierto no registra salidas ni cobros con turnos activos', async () => {
    const { ds, turnos } = fuente(true, false);
    const error = await en(sesion('USER'), ds).catch((e) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse()).toEqual(expect.objectContaining({ code: TURNO_REQUERIDO }));
    // Busca el turno propio, cualquiera sea el medio de pago.
    expect(turnos.exists).toHaveBeenCalledWith({ where: { usuarioApertura: { id: 'usuario' }, estado: 'ABIERTO' } });
  });

  test('con su turno abierto el operador sigue', async () => {
    const { ds } = fuente(true, true);
    await expect(en(sesion('USER'), ds)).resolves.toBeUndefined();
  });

  test.each(['ADMIN', 'SUPER_ADMIN'])('%s registra salidas sin turno y no se consulta nada', async (role) => {
    const { ds, settings, turnos } = fuente(true, false);
    await expect(en(sesion(role), ds)).resolves.toBeUndefined();
    expect(settings.findOne).not.toHaveBeenCalled();
    expect(turnos.exists).not.toHaveBeenCalled();
  });

  test.each([false, null])('con turnos desactivados (%s) no se exige turno', async (shiftsEnabled) => {
    const { ds, turnos } = fuente(shiftsEnabled, false);
    await expect(en(sesion('USER'), ds)).resolves.toBeUndefined();
    expect(turnos.exists).not.toHaveBeenCalled();
  });

  test('en modalidad gratuita no hay caja ni turnos', async () => {
    const { ds, settings } = fuente(true, false);
    await expect(en(sesion('USER', 'GRATUITO'), ds)).resolves.toBeUndefined();
    expect(settings.findOne).not.toHaveBeenCalled();
  });
});

describe('cobroSinTurno: qué cobros por QR o alias no son de una salida', () => {
  test.each([
    [{ tipo: 'INQUILINO' }, true],
    [{ tipo: 'ABONO', alIngresar: true }, true],
    // El servicio ignora alIngresar con HORA: no puede saltear el control.
    [{ tipo: 'HORA', alIngresar: true }, false],
    [{ tipo: 'HORA' }, false],
    [{ tipo: 'ABONO' }, false],
    [{}, false],
  ])('%j → %s', (dto, esperado) => expect(cobroSinTurno(dto)).toBe(esperado));
});

describe('QR y alias de una salida piden turno aunque digan alIngresar', () => {
  const req = { user: { userId: 'usuario' } };
  const dto = { registrationId: 'estadia', tipo: 'HORA' as const, alIngresar: true };
  test('QR', async () => {
    const crear = jest.fn();
    const controller = new CobrosMercadoPagoController({ crear } as never, fuente(true, false).ds);
    await expect(tenantContext.run(sesion('USER'), () => controller.crearCobro(dto as never, req))).rejects.toBeInstanceOf(ForbiddenException);
    expect(crear).not.toHaveBeenCalled();
  });
  test('alias', async () => {
    const iniciar = jest.fn();
    const controller = new VerificacionAliasController({ iniciar } as never, fuente(true, false).ds);
    await expect(tenantContext.run(sesion('USER'), () => controller.iniciarCobro(req, dto as never))).rejects.toBeInstanceOf(ForbiddenException);
    expect(iniciar).not.toHaveBeenCalled();
  });
  test('el pase cobrado al ingresar no pide turno', async () => {
    const crear = jest.fn().mockResolvedValue({ id: 'cobro' });
    const controller = new CobrosMercadoPagoController({ crear } as never, fuente(true, false).ds);
    await tenantContext.run(sesion('USER'), () => controller.crearCobro({ registrationId: 'estadia', tipo: 'ABONO', alIngresar: true } as never, req));
    expect(crear).toHaveBeenCalled();
  });
});
