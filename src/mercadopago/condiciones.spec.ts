import { BadRequestException } from '@nestjs/common';
import { MercadoPagoService } from './mercadopago.service';
import { CONDICIONES_VIGENTES, condicionesDeVersion } from './condiciones';
import { TenantScope, tenantContext } from '../tenancy/tenant-context';

const ADMIN: TenantScope = {
  empresaId: 'e1',
  playaId: 'p1',
  userId: 'u1',
  role: 'ADMIN',
};

function servicio(cuenta: Record<string, any> | null) {
  const save = jest.fn(async (fila) => fila);
  const s = new MercadoPagoService(
    { findOneBy: jest.fn().mockResolvedValue(cuenta), save } as any,
    { get: () => undefined } as any,
  );
  return { s, save };
}

const como = <T>(hacer: () => Promise<T> | T) =>
  tenantContext.run(ADMIN, hacer);

describe('Condiciones de uso de MercadoPago', () => {
  test('la vigente se encuentra por su versión y una desconocida no', () => {
    expect(condicionesDeVersion(CONDICIONES_VIGENTES.version)).toBe(
      CONDICIONES_VIGENTES,
    );
    expect(condicionesDeVersion('1999-01-01')).toBeNull();
    expect(condicionesDeVersion(null)).toBeNull();
  });

  test('sin aceptar la versión vigente no sale el link para conectar', () => {
    const { s } = servicio(null);
    for (const version of ['', '2020-01-01'])
      expect(() => como(() => s.iniciarConexion('u1', version))).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: 'CONDICIONES_DESACTUALIZADAS',
          }),
        }),
      );
  });

  test('una cuenta ya conectada acepta las vigentes: queda quién y cuándo', async () => {
    const cuenta: Record<string, any> = {
      empresaId: 'e1',
      mpUserId: '111',
      estado: 'ACTIVA',
      condicionesVersion: null,
    };
    const { s, save } = servicio(cuenta);
    const r = await como(() =>
      s.aceptarCondiciones('u1', CONDICIONES_VIGENTES.version),
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(cuenta).toMatchObject({
      condicionesVersion: CONDICIONES_VIGENTES.version,
      condicionesAceptadasPor: 'u1',
    });
    expect(cuenta.condicionesAceptadasEl).toBeInstanceOf(Date);
    expect(r).toMatchObject({
      conectada: true,
      condicionesAceptadas: { alDia: true },
    });
  });

  test('sin cuenta conectada no hay nada que aceptar', async () => {
    for (const cuenta of [null, { empresaId: 'e1', estado: 'DESCONECTADA' }]) {
      const { s, save } = servicio(cuenta);
      await expect(
        como(() => s.aceptarCondiciones('u1', CONDICIONES_VIGENTES.version)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(save).not.toHaveBeenCalled();
    }
  });

  test('desconectar retira el consentimiento', async () => {
    const cuenta: Record<string, any> = {
      empresaId: 'e1',
      estado: 'ACTIVA',
      accessToken: 'x',
      refreshToken: 'y',
      condicionesVersion: CONDICIONES_VIGENTES.version,
      condicionesAceptadasEl: new Date(),
      condicionesAceptadasPor: 'u1',
    };
    const { s } = servicio(cuenta);
    await como(() => s.desconectar());
    expect(cuenta).toMatchObject({
      estado: 'DESCONECTADA',
      condicionesVersion: null,
      condicionesAceptadasEl: null,
      condicionesAceptadasPor: null,
    });
  });
});
