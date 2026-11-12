import { EventEmitter } from 'events';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { rutaSanitizada, solicitudMiddleware } from './solicitud.middleware';
import { SaludController } from './salud.controller';
import { TenantGuard } from '../tenancy/tenant-access';

function respuesta(statusCode = 200) {
  const res = Object.assign(new EventEmitter(), { statusCode, headers: {} as Record<string, string> });
  return Object.assign(res, { setHeader: (k: string, v: string) => (res.headers[k.toLowerCase()] = v) });
}

describe('Correlación de solicitudes', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reutiliza el id del frontend y registra un 5xx sin consulta, cuerpo ni encabezados', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const res = respuesta(502);
    const next = jest.fn();
    solicitudMiddleware(
      {
        method: 'GET',
        originalUrl: '/tickets/registrations/0b9c6a0e-1c4f-4a65-9f52-1f8e2f3e0a11/receipt?token=secreto',
        headers: { 'x-request-id': 'front-1234abcd', authorization: 'Bearer secreto' },
        body: { password: 'secreta' },
      } as never,
      res as never,
      next,
    );
    expect(next).toHaveBeenCalled();
    expect(res.headers['x-request-id']).toBe('front-1234abcd');
    res.emit('finish');
    const linea = String(warn.mock.calls[0][0]);
    expect(JSON.parse(linea)).toMatchObject({ requestId: 'front-1234abcd', metodo: 'GET', ruta: '/tickets/registrations/:id/receipt', estado: 502 });
    expect(linea).not.toMatch(/secreto|secreta|token=/);
  });

  it('crea un id propio si el recibido no es seguro y no registra respuestas correctas o rechazos', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    for (const estado of [200, 403, 429]) {
      const res = respuesta(estado);
      solicitudMiddleware({ method: 'GET', originalUrl: '/tenant/context', headers: { 'x-request-id': 'x\n<script>' } } as never, res as never, jest.fn());
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      res.emit('finish');
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('oculta patentes e identificadores en la ruta', () => {
    expect(rutaSanitizada('/tickets/plate/AB123CD/status')).toBe('/tickets/plate/:patente/status');
    expect(rutaSanitizada('/tickets/plate/abc123')).toBe('/tickets/plate/:patente');
    expect(rutaSanitizada('/mercadopago/cobros/123456789')).toBe('/mercadopago/cobros/:id');
    expect(rutaSanitizada('/tenant/context')).toBe('/tenant/context');
  });
});

describe('Disponibilidad', () => {
  const res = { setHeader: jest.fn() };

  it('responde listo con la versión cuando la base contesta', async () => {
    const salud = new SaludController({ query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) } as never);
    await expect(salud.estado(res as never)).resolves.toEqual({ estado: 'listo', version: expect.any(String) });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('responde 503 con un código y sin el detalle de la conexión', async () => {
    const salud = new SaludController({ query: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED db.internal:5432 usuario=admin')) } as never);
    const error = await salud.estado(res as never).catch((e) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify(error.getResponse())).not.toMatch(/ECONNREFUSED|admin|5432/);
    expect(error.getResponse()).toMatchObject({ code: 'BASE_NO_DISPONIBLE' });
  });

  it('pasa el guard sin sesión solo en su handler', async () => {
    const guard = new TenantGuard({ getOrThrow: () => 'secreto-de-servicio' } as never);
    const contexto = (handler: (...args: never[]) => unknown) =>
      ({
        getType: () => 'http',
        getClass: () => SaludController,
        getHandler: () => handler,
        switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
      }) as never;
    await expect(guard.canActivate(contexto(SaludController.prototype.estado))).resolves.toBe(true);
    await expect(guard.canActivate(contexto(function otro() {}))).rejects.toThrow();
  });
});
