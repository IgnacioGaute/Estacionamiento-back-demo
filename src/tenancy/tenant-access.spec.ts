import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantGuard } from './tenant-access';
import { limitLogin } from '../auth/login-limiter';

// El JWT real lo valida passport contra la base. Acá la sesión ya viene resuelta en `req.sesion`:
// lo que se prueba es la decisión del guard, no la firma del token.
jest.mock('../utils/guards/auth.guard', () => ({
  JwtAuthGuard: class {
    async canActivate(context: ExecutionContext) {
      const req = context.switchToHttp().getRequest();
      if (!req.sesion) return false;
      req.user = req.sesion;
      return true;
    }
  },
}));
jest.mock('../auth/login-limiter', () => ({ limitLogin: jest.fn() }));

const SECRETO = 'token-de-servicio';
const guard = new TenantGuard({ getOrThrow: () => SECRETO } as unknown as ConfigService);

type Sesion = { userId: string; role: 'USER' | 'ADMIN' | 'SUPER_ADMIN'; empresaEstado?: 'ACTIVA' | 'SUSPENDIDA' };
const operador: Sesion = { userId: 'op-1', role: 'USER', empresaEstado: 'ACTIVA' };
const admin: Sesion = { userId: 'adm-1', role: 'ADMIN', empresaEstado: 'ACTIVA' };
const superAdmin: Sesion = { userId: 'root', role: 'SUPER_ADMIN' };
const suspendida = (s: Sesion): Sesion => ({ ...s, empresaEstado: 'SUSPENDIDA' });

const pedir = (
  controller: string,
  handler: string,
  { sesion, headers = {}, params = {}, body = {}, ip = '10.0.0.1' }: { sesion?: Sesion; headers?: Record<string, string>; params?: Record<string, string>; body?: unknown; ip?: string } = {},
) => {
  const req: Record<string, unknown> = { sesion, headers, params, body, ip };
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
    getClass: () => ({ name: controller }),
    getHandler: () => ({ name: handler }),
  } as unknown as ExecutionContext;
  return { req, resultado: guard.canActivate(context) };
};
const deja = (controller: string, handler: string, opciones?: Parameters<typeof pedir>[2]) =>
  expect(pedir(controller, handler, opciones).resultado).resolves.toBe(true);
const rechaza = (controller: string, handler: string, opciones: Parameters<typeof pedir>[2] | undefined, error: unknown) =>
  expect(pedir(controller, handler, opciones).resultado).rejects.toThrow(error as never);

describe('TenantGuard: quién puede llamar a qué', () => {
  describe('rutas sin sesión', () => {
    test('el comprobante público y el aviso de MercadoPago no piden sesión', async () => {
      await deja('PublicParkingReceiptsController', 'read');
      await deja('AvisoMercadoPagoController', 'aviso');
    });

    test('solo el handler público de ese controlador: el resto pide sesión', async () => {
      await rechaza('AvisoMercadoPagoController', 'otraCosa', {}, UnauthorizedException);
    });

    test('el login no pide token pero limita intentos con la IP de la conexión, no la reenviada', async () => {
      await deja('AuthController', 'login', { ip: '10.9.9.9', headers: { 'x-forwarded-for': '1.2.3.4' }, body: { identifier: 'ana' } });
      expect(limitLogin).toHaveBeenCalledWith('10.9.9.9', 'ana');
    });

    test('el resto de AuthController solo con el token de servicio; una sesión de usuario no alcanza', async () => {
      await deja('AuthController', 'findUserByEmail', { headers: { authorization: `Bearer ${SECRETO}` } });
      await rechaza('AuthController', 'findUserByEmail', {}, UnauthorizedException);
      await rechaza('AuthController', 'findUserByEmail', { sesion: superAdmin }, UnauthorizedException);
    });
  });

  describe('token de servicio', () => {
    test('sirve para que NextAuth lea cuentas de usuario, y marca el pedido como de plataforma', async () => {
      const { req, resultado } = pedir('UsersController', 'findOne', { headers: { authorization: `Bearer ${SECRETO}` } });
      await expect(resultado).resolves.toBe(true);
      expect(req.platformAccountService).toBe(true);
    });

    test('no abre ninguna ruta operativa', async () => {
      const servicio = { headers: { authorization: `Bearer ${SECRETO}` } };
      await rechaza('TicketsController', 'findAllRegistrations', servicio, UnauthorizedException);
      await rechaza('UsersController', 'remove', servicio, UnauthorizedException);
    });
  });

  test('sin sesión no se entra a nada operativo', async () => {
    await rechaza('TicketsController', 'createRegistrationByPlate', {}, UnauthorizedException);
  });

  describe('operador (USER)', () => {
    test('usa lo que está en su lista: ingresos, salidas, turnos, cobro a inquilinos', async () => {
      await deja('TicketsController', 'createRegistrationByPlate', { sesion: operador });
      await deja('TicketsController', 'closeRegistrationByPlate', { sesion: operador });
      await deja('TurnosController', 'close', { sesion: operador });
      await deja('CuentasController', 'registrarPago', { sesion: operador });
    });

    test('lo que no está en su lista es de administración, aunque el controlador sí esté', async () => {
      await rechaza('TicketsController', 'updateSchedule', { sesion: operador }, 'requiere un administrador');
      await rechaza('TicketsController', 'createPriceBracket', { sesion: operador }, 'requiere un administrador');
      await rechaza('CuentasController', 'anular', { sesion: operador }, 'requiere un administrador');
      await rechaza('MercadoPagoController', 'conectar', { sesion: operador }, 'requiere un administrador');
    });

    test('un handler nuevo que nadie sumó a la lista queda solo para administradores', async () => {
      await rechaza('TicketsController', 'handlerQueTodaviaNoExiste', { sesion: operador }, ForbiddenException);
    });

    test('con usuarios, solo leerse a sí mismo y cambiar su contraseña', async () => {
      await deja('UsersController', 'findOne', { sesion: operador, params: { id: 'op-1' } });
      await deja('UsersController', 'updatePassword', { sesion: operador, params: { id: 'op-1' } });
      await rechaza('UsersController', 'findOne', { sesion: operador, params: { id: 'otro' } }, 'Solo el administrador gestiona usuarios');
      await rechaza('UsersController', 'remove', { sesion: operador, params: { id: 'op-1' } }, 'Solo el administrador gestiona usuarios');
    });
  });

  test('el administrador y el super admin pasan el guard (el alcance lo ponen el interceptor y la RLS)', async () => {
    await deja('TicketsController', 'updateSchedule', { sesion: admin });
    await deja('UsersController', 'findOne', { sesion: admin, params: { id: 'otro' } });
    await deja('TicketsController', 'updateSchedule', { sesion: superAdmin });
  });

  describe('empresa suspendida', () => {
    test('puede terminar lo abierto: buscar y cobrar salidas, comprobante, turno, ver su plan', async () => {
      await deja('TicketsController', 'searchActiveRegistrations', { sesion: suspendida(operador) });
      await deja('TicketsController', 'closeRegistrationByPlate', { sesion: suspendida(operador) });
      await deja('TicketsController', 'issueParkingReceipt', { sesion: suspendida(operador) });
      await deja('TurnosController', 'close', { sesion: suspendida(operador) });
      await deja('MiPlanController', 'estado', { sesion: suspendida(admin) });
      await deja('MiPlanController', 'pagarConMercadoPago', { sesion: suspendida(admin) });
    });

    test('no abre estadías nuevas ni cambia configuración, cualquiera sea el rol', async () => {
      const codigo = expect.objectContaining({ response: expect.objectContaining({ code: 'EMPRESA_SUSPENDIDA' }) });
      await expect(pedir('TicketsController', 'createRegistrationByPlate', { sesion: suspendida(operador) }).resultado).rejects.toEqual(codigo);
      await expect(pedir('TicketsController', 'updateSchedule', { sesion: suspendida(admin) }).resultado).rejects.toEqual(codigo);
      await expect(pedir('CuentasController', 'registrarPago', { sesion: suspendida(admin) }).resultado).rejects.toEqual(codigo);
    });

    test('suspendida no le da al operador lo que su rol no tiene', async () => {
      await rechaza('MiPlanController', 'estado', { sesion: suspendida(operador) }, 'requiere un administrador');
    });
  });

  test('fuera de HTTP (sockets) no decide: eso lo hace TenantSocketAccess', async () => {
    const socket = { getType: () => 'ws' } as unknown as ExecutionContext;
    await expect(guard.canActivate(socket)).resolves.toBe(true);
  });
});
