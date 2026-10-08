import { lastValueFrom, of } from 'rxjs';
import { AuditInterceptor } from './audit-interceptor';
import { tenantContext } from './tenant-context';

// Lo que deja en audit_log cada regla de AUDIT_RULES que no es un simple «campos del cuerpo»: datos
// de la respuesta, la playa del cuerpo, el estado anterior por empresa y los handlers que pueden
// responder sin haber cambiado nada. Sin base: la DataSource es un doble que guarda lo insertado.

const scope = {
  empresaId: '00000000-0000-4000-8000-0000000000e1',
  playaId: '00000000-0000-4000-8000-0000000000a1',
  userId: '00000000-0000-4000-8000-0000000000c1',
  role: 'ADMIN',
};

function preparar(filaPrevia: Record<string, unknown> | null = null) {
  const insertados: Record<string, any>[] = [];
  const consultas: { sql: string; params: unknown[] }[] = [];
  const ds = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      consultas.push({ sql, params });
      return filaPrevia ? [filaPrevia] : [];
    }),
    getRepository: () => ({
      insert: jest.fn(async (fila: Record<string, any>) => {
        insertados.push(fila);
      }),
    }),
  };
  return { interceptor: new AuditInterceptor(ds as any), insertados, consultas };
}

async function correr(
  interceptor: AuditInterceptor,
  clase: string,
  handler: string,
  req: Record<string, unknown>,
  respuesta: unknown,
) {
  const contexto = {
    getType: () => 'http',
    getClass: () => ({ name: clase }),
    getHandler: () => ({ name: handler }),
    switchToHttp: () => ({ getRequest: () => ({ params: {}, ...req }) }),
  };
  await tenantContext.run(scope as any, async () => {
    const flujo = await interceptor.intercept(contexto as any, { handle: () => of(respuesta) });
    await lastValueFrom(flujo);
  });
}

describe('AuditInterceptor', () => {
  it('conectar MercadoPago guarda la cuenta de la respuesta y nunca el código del cuerpo', async () => {
    const { interceptor, insertados } = preparar();
    await correr(interceptor, 'MercadoPagoController', 'callback', { body: { code: 'TG-secreto', state: 'abc' } }, { conectada: true, nickname: 'PLAYAMITRE', email: 'x@y.z' });
    expect(insertados).toHaveLength(1);
    expect(insertados[0]).toMatchObject({ accion: 'MERCADOPAGO_CONECTADO', empresaId: scope.empresaId, usuarioId: scope.userId });
    expect(insertados[0].detalle).toEqual({ nickname: 'PLAYAMITRE' });
  });

  it('la caja QR va a la playa del cuerpo y no se registra si no se pudo crear', async () => {
    const { interceptor, insertados } = preparar();
    const otraPlaya = '00000000-0000-4000-8000-0000000000a2';
    await correr(interceptor, 'MercadoPagoController', 'crearCajaQrConUbicacion', { body: { playaId: otraPlaya, latitud: -24.7, longitud: -65.4 } }, { creada: false, motivo: 'sin localidad' });
    expect(insertados).toHaveLength(0);
    await correr(interceptor, 'MercadoPagoController', 'crearCajaQrConUbicacion', { body: { playaId: otraPlaya, latitud: -24.7, longitud: -65.4 } }, { creada: true });
    expect(insertados).toHaveLength(1);
    expect(insertados[0]).toMatchObject({ accion: 'QR_CAJA_CREADA', playaId: otraPlaya });
  });

  it('el alias compara contra la cuenta de la empresa y guarda solo lo que cambió', async () => {
    const { interceptor, insertados, consultas } = preparar({ verificacionAlias: false, alias: 'playa.mitre', accessToken: 'cifrado' });
    await correr(interceptor, 'MercadoPagoController', 'configurarVerificacionAlias', { body: { activa: true, alias: 'playa.mitre' } }, {});
    expect(consultas[0].sql).toContain('FROM "mercadopago_cuentas" WHERE "empresaId" = $1');
    expect(consultas[0].params).toEqual([scope.empresaId]);
    expect(insertados[0].detalle).toEqual({ activa: { de: false, a: true } });
  });

  it('las comisiones nunca configuradas cuentan como vacías y un null no es un cambio', async () => {
    const { interceptor, insertados, consultas } = preparar({ id: scope.empresaId, comisionesMp: null });
    const body = { qrSaldo: 1.5, qrDebito: null, qrCredito: null, aliasSaldo: null, aliasDebito: null, aliasCredito: null };
    await correr(interceptor, 'BoxListsController', 'configurarComisiones', { body }, {});
    expect(consultas[0].sql).toContain('FROM "empresas" WHERE "id" = $1');
    expect(insertados[0]).toMatchObject({ accion: 'COMISIONES_CAMBIADAS' });
    expect(insertados[0].detalle).toEqual({ qrSaldo: { de: null, a: 1.5 } });
  });

  it('un handler sin regla no registra nada', async () => {
    const { interceptor, insertados } = preparar();
    await correr(interceptor, 'MercadoPagoController', 'conectar', { body: { condiciones: '2026-09' } }, { url: 'https://auth' });
    expect(insertados).toHaveLength(0);
  });
});
