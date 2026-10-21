import { CallHandler, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { EntityManager } from 'typeorm';
import { TenantInterceptor, TenantAccessService } from './tenant-access';
import { tenantContext, TenantScope } from './tenant-context';
import { exigirCobro, modalidadParaIngreso } from './modalidad';
import { FREE_MODE_BLOCKED } from './endpoint-policy';

// El corte por modalidad vive en el interceptor (después de resolver la playa) y se repite dentro
// de las transacciones de dinero. Acá se prueba la decisión; la carrera con el cambio de modalidad
// y la RLS se cubren en test/modalidad.integration.cjs.

const scope = (modalidad: 'CON_COBRO' | 'GRATUITO', role = 'USER'): TenantScope => ({ empresaId: 'e', playaId: 'p', userId: 'u', role, modalidad });

function interceptar(controller: string, handler: string, modalidad: 'CON_COBRO' | 'GRATUITO', role = 'USER') {
  const access = { resolve: jest.fn().mockResolvedValue(scope(modalidad, role)) } as unknown as TenantAccessService;
  const interceptor = new TenantInterceptor(access);
  const req = { user: { userId: 'u' }, headers: {} };
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
    getClass: () => ({ name: controller }),
    getHandler: () => ({ name: handler }),
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of('ok') };
  return interceptor.intercept(context, next).then((obs) => lastValueFrom(obs));
}

describe('Modalidad gratuita: corte de endpoints', () => {
  test('en una playa gratuita los endpoints financieros responden MODALIDAD_GRATUITA, para cualquier rol', async () => {
    for (const role of ['USER', 'ADMIN', 'SUPER_ADMIN'])
      for (const [controller, handler] of [
        ['TicketsController', 'closeRegistrationByPlate'],
        ['TicketsController', 'addAdvancePayment'],
        ['TicketsController', 'discountRegistration'],
        ['TicketsController', 'previewPrice'],
        ['TicketsController', 'registrarSalidaAnterior'],
        ['TurnosController', 'open'],
        ['BoxListsController', 'createOtherPayment'],
        ['CuentasController', 'registrarPago'],
        ['CobrosMercadoPagoController', 'crearCobro'],
        ['VerificacionAliasController', 'iniciarCobro'],
      ]) {
        const error = await interceptar(controller, handler, 'GRATUITO', role).catch((e) => e);
        expect(error).toBeInstanceOf(ForbiddenException);
        expect(error.getResponse()).toMatchObject({ code: 'MODALIDAD_GRATUITA' });
      }
  });

  test('las operaciones no financieras siguen: ingresos, salida gratuita, búsquedas, planilla e historial', async () => {
    for (const [controller, handler] of [
      ['TicketsController', 'createRegistrationByPlate'],
      ['TicketsController', 'registrarSalida'],
      ['TicketsController', 'getCloseSummary'],
      ['TicketsController', 'searchActiveRegistrations'],
      ['TicketsController', 'planillaVehiculos'],
      ['TicketsController', 'corregirDatos'],
      ['ScannerController', 'startScanner'],
      ['BoxListsController', 'findBoxByDate'],
      ['TurnosController', 'findAll'],
    ])
      await expect(interceptar(controller, handler, 'GRATUITO')).resolves.toBe('ok');
  });

  test('con cobro no cambia nada', async () => {
    for (const [controller, handlers] of Object.entries(FREE_MODE_BLOCKED))
      for (const handler of handlers) await expect(interceptar(controller, handler, 'CON_COBRO', 'ADMIN')).resolves.toBe('ok');
  });

  test('la facturación SaaS no depende de la modalidad', () => {
    expect(FREE_MODE_BLOCKED.MiPlanController).toBeUndefined();
    expect(FREE_MODE_BLOCKED.SuscripcionesController).toBeUndefined();
  });
});

describe('Modalidad dentro de la transacción', () => {
  const manager = (modalidad: string | undefined) => ({ query: jest.fn(async (sql: string) => (sql.startsWith('SELECT modalidad') ? (modalidad ? [{ modalidad }] : []) : [])) });

  test('exigirCobro toma el bloqueo de caja exclusivo y corta si la playa es gratuita', async () => {
    const m = manager('GRATUITO');
    await expect(tenantContext.run(scope('CON_COBRO'), () => exigirCobro(m as unknown as EntityManager))).rejects.toThrow(ForbiddenException);
    expect(m.query).toHaveBeenNthCalledWith(1, 'SELECT pg_advisory_xact_lock(718904)');
  });

  test('exigirCobro deja pasar con cobro, y sin playa en el scope no consulta nada', async () => {
    const m = manager('CON_COBRO');
    await expect(tenantContext.run(scope('GRATUITO'), () => exigirCobro(m as unknown as EntityManager))).resolves.toBeUndefined();
    const sinScope = manager('GRATUITO');
    await expect(exigirCobro(sinScope as unknown as EntityManager)).resolves.toBeUndefined();
    expect(sinScope.query).not.toHaveBeenCalled();
  });

  test('el ingreso lee la modalidad de la base (no la del scope) con el bloqueo de tarifas compartido', async () => {
    const m = manager('GRATUITO');
    await expect(tenantContext.run(scope('CON_COBRO'), () => modalidadParaIngreso(m as unknown as EntityManager))).resolves.toBe('GRATUITO');
    expect(m.query).toHaveBeenNthCalledWith(1, 'SELECT pg_advisory_xact_lock_shared(718903)');
    await expect(tenantContext.run(scope('CON_COBRO'), () => modalidadParaIngreso(manager(undefined) as unknown as EntityManager))).resolves.toBe('CON_COBRO');
  });
});
