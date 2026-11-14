import { totalesRecibidos, totalesRegistrados } from './control-turno';
import { ControlTurnoMercadoPagoService } from './control-turno.service';
import { TenantScope, tenantContext } from '../tenancy/tenant-context';

const CUENTA = '111';
const DESDE = new Date('2026-11-13T09:57:00Z'); // 06:57 en Argentina
const HASTA = new Date('2026-11-13T18:10:00Z'); // 15:10

let numero = 0;
const pago = (p: Record<string, unknown>) => ({
  id: ++numero,
  collector_id: 111,
  status: 'approved',
  currency_id: 'ARS',
  date_created: '2026-11-13T13:00:00.000-03:00',
  date_approved: '2026-11-13T13:00:00.000-03:00',
  ...p,
});
const transferencia = (importe: number, extra: Record<string, unknown> = {}) =>
  pago({
    transaction_amount: importe,
    payment_type_id: 'bank_transfer',
    point_of_interaction: { type: 'PSP_TRANSFER' },
    ...extra,
  });
const a = (hora: string) => ({
  date_created: `2026-11-13T${hora}:00.000-03:00`,
  date_approved: `2026-11-13T${hora}:00.000-03:00`,
});

describe('Control de Mercado Pago del turno: totales', () => {
  test('separa transferencias, QR del sistema y otros ingresos', () => {
    const t = totalesRecibidos(
      [
        transferencia(3500),
        transferencia(7000),
        pago({ transaction_amount: 4000, external_reference: 'cobro-1', payment_type_id: 'account_money' }),
        pago({ transaction_amount: 1500, payment_type_id: 'credit_card' }),
      ],
      CUENTA,
      DESDE,
      HASTA,
    );
    expect(t).toEqual({ total: 16000, transferencias: 10500, qr: 4000, otros: 1500, cantidad: 4 });
  });

  test('deja afuera lo que no entró a la cuenta en el horario del turno', () => {
    const t = totalesRecibidos(
      [
        transferencia(3500, a('06:50')),
        transferencia(3500, a('15:11')),
        transferencia(3500, { status: 'pending' }),
        transferencia(3500, { status: 'refunded' }),
        transferencia(3500, { currency_id: 'USD' }),
        // Lo que pagó la cuenta (una compra, una suscripción).
        transferencia(3500, { collector_id: 999 }),
        transferencia(0),
      ],
      CUENTA,
      DESDE,
      HASTA,
    );
    expect(t).toEqual({ total: 0, transferencias: 0, qr: 0, otros: 0, cantidad: 0 });
  });

  test('un pago repetido por la paginación se cuenta una vez', () => {
    const p = transferencia(3500);
    expect(totalesRecibidos([p, p], CUENTA, DESDE, HASTA).total).toBe(3500);
  });

  test('lo registrado suma QR, alias y transferencias a mano; el cheque no', () => {
    expect(
      totalesRegistrados([
        { medio: 'QR', total: '35500' },
        { medio: 'ALIAS', total: '105500' },
        { medio: 'TRANSFER', total: 7500 },
        { medio: 'CHECK', total: 20000 },
      ]),
    ).toEqual({ total: 148500, alias: 105500, qr: 35500, transferencias: 7500 });
  });
});

describe('Control de Mercado Pago del turno: servicio', () => {
  const ADMIN: TenantScope = { empresaId: 'e1', playaId: 'p1', userId: 'u1', role: 'ADMIN' };
  const OPERADOR: TenantScope = { ...ADMIN, userId: 'u2', role: 'USER' };
  const cuentaOk = {
    empresaId: 'e1',
    mpUserId: CUENTA,
    estado: 'ACTIVA',
    accessToken: 'cifrado',
    condicionesVersion: '2026-11-13',
  };
  const turnoBase = () => ({
    id: 't1',
    estado: 'CERRADO',
    fechaApertura: DESDE,
    fechaCierre: HASTA,
    usuarioApertura: { id: 'u2' },
    controlMercadoPago: null as any,
  });

  function servicio(cuenta: Record<string, unknown> | null = cuentaOk, turno = turnoBase()) {
    const update = jest.fn().mockResolvedValue(undefined);
    const query = jest.fn(async (sql: string) =>
      sql.includes('FROM playas')
        ? [{ playas: 1 }]
        : [
            { medio: 'ALIAS', total: '10500' },
            { medio: 'QR', total: '4000' },
          ],
    );
    const dataSource = {
      getRepository: () => ({ findOne: jest.fn().mockResolvedValue(turno), update }),
      query,
    };
    const tokenDeEmpresa = jest.fn().mockResolvedValue('token');
    const alCerrarTurno = jest.fn();
    const s = new ControlTurnoMercadoPagoService(
      { findOneBy: jest.fn().mockResolvedValue(cuenta) } as any,
      { tokenDeEmpresa } as any,
      { alCerrarTurno } as any,
      dataSource as any,
    );
    return { s, update, query, tokenDeEmpresa, alCerrarTurno, turno };
  }

  const respuesta = (results: unknown[]) =>
    ({ ok: true, json: async () => ({ results, paging: { total: results.length } }) }) as any;

  afterEach(() => jest.restoreAllMocks());

  test('al cerrar guarda en el turno lo que entró contra lo registrado', async () => {
    const { s, update, turno } = servicio();
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(
      respuesta([
        transferencia(3500),
        transferencia(7000),
        transferencia(3500), // cobrada por alias y cargada como efectivo
        pago({ transaction_amount: 4000, external_reference: 'cobro-1' }),
      ]),
    );
    const control = await tenantContext.run(OPERADOR, () => s.guardar(turno as any));
    expect(control).toMatchObject({
      estado: 'OK',
      mercadoPago: { total: 18000, transferencias: 14000, qr: 4000 },
      sistema: { total: 14500, alias: 10500, qr: 4000 },
      diferencia: 3500,
      variasPlayas: false,
    });
    expect(update).toHaveBeenCalledWith('t1', { controlMercadoPago: control });
    // Solo totales: ningún pago queda guardado.
    expect(JSON.stringify(control)).not.toMatch(/bank_transfer|cobro-1|collector/);
    expect(String(fetch.mock.calls[0][0])).toContain('/v1/payments/search');
  });

  test('sin las condiciones nuevas aceptadas no consulta ni guarda nada', async () => {
    for (const cuenta of [null, { ...cuentaOk, condicionesVersion: '2026-10-06' }, { ...cuentaOk, estado: 'ERROR' }]) {
      const { s, update, tokenDeEmpresa, turno } = servicio(cuenta);
      const fetch = jest.spyOn(global, 'fetch');
      await expect(tenantContext.run(OPERADOR, () => s.guardar(turno as any))).resolves.toBeNull();
      expect(fetch).not.toHaveBeenCalled();
      expect(tokenDeEmpresa).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      fetch.mockRestore();
    }
  });

  test('si Mercado Pago no responde queda anotado y el historial lo puede volver a pedir', async () => {
    const { s, update, turno } = servicio();
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500, body: { cancel: jest.fn() } } as any);
    const control = await tenantContext.run(OPERADOR, () => s.guardar(turno as any));
    expect(control).toMatchObject({ estado: 'ERROR', message: expect.stringContaining('500') });
    expect(update).toHaveBeenCalledTimes(1);
    // El historial vuelve a consultar un control con error.
    turno.controlMercadoPago = control;
    jest.spyOn(global, 'fetch').mockResolvedValue(respuesta([]));
    await expect(tenantContext.run(ADMIN, () => s.consultar('t1', 'u1', 'ADMIN'))).resolves.toMatchObject({ estado: 'OK' });
    expect(update).toHaveBeenCalledTimes(2);
    // Uno correcto queda como se guardó al cerrar.
    turno.controlMercadoPago = { estado: 'OK', diferencia: 0 };
    const fetch = jest.spyOn(global, 'fetch');
    fetch.mockClear();
    await expect(tenantContext.run(ADMIN, () => s.consultar('t1', 'u1', 'ADMIN'))).resolves.toEqual({ estado: 'OK', diferencia: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('un turno viejo sin control lo consulta un administrador con el horario de ese turno, y queda guardado', async () => {
    const { s, update, turno } = servicio();
    // Un operador no consulta turnos cerrados, ni el suyo.
    await expect(tenantContext.run(OPERADOR, () => s.consultar('t1', 'u2', 'USER'))).rejects.toMatchObject({
      response: { code: 'SOLO_ADMINISTRACION' },
    });
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(respuesta([transferencia(3500)]));
    const control = await tenantContext.run(ADMIN, () => s.consultar('t1', 'u1', 'ADMIN'));
    expect(control).toMatchObject({ estado: 'OK', desde: DESDE.toISOString(), hasta: HASTA.toISOString() });
    expect(update).toHaveBeenCalledWith('t1', { controlMercadoPago: control });
    // La búsqueda va del rato antes de abrir al cierre del turno, no hasta hoy.
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(new Date(url.searchParams.get('begin_date')!).getTime()).toBeLessThanOrEqual(DESDE.getTime());
    expect(new Date(url.searchParams.get('end_date')!).getTime()).toBe(HASTA.getTime() + 60_000);
    expect(turno.controlMercadoPago).toBe(control);
  });

  test('otro operador no puede ver el control de un turno ajeno', async () => {
    const { s } = servicio();
    await expect(
      tenantContext.run({ ...OPERADOR, userId: 'u3' }, () => s.consultar('t1', 'u3', 'USER')),
    ).rejects.toMatchObject({ status: 403 });
  });

  test('se engancha al cierre de turnos', () => {
    const { s, alCerrarTurno } = servicio();
    s.onModuleInit();
    expect(alCerrarTurno).toHaveBeenCalledWith(expect.any(Function));
  });
});
