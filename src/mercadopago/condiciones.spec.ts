import { BadRequestException } from '@nestjs/common';
import { MercadoPagoService } from './mercadopago.service';
import {
  CONDICIONES_VIGENTES,
  VERSION_VERIFICACION_ALIAS,
  aceptoAlMenos,
  condicionesDeVersion,
} from './condiciones';
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

  test('una versión nueva no apaga lo que ya estaba aceptado', () => {
    // Las empresas que aceptaron 2026-10-06 o 2026-11-13 siguen cobrando con QR y alias.
    for (const v of ['2026-10-06', '2026-11-13', CONDICIONES_VIGENTES.version])
      expect(aceptoAlMenos(v, VERSION_VERIFICACION_ALIAS)).toBe(true);
    // Una anterior, nula o inventada no alcanza.
    expect(aceptoAlMenos('2026-10-05', VERSION_VERIFICACION_ALIAS)).toBe(false);
    expect(aceptoAlMenos(null, VERSION_VERIFICACION_ALIAS)).toBe(false);
    expect(aceptoAlMenos('2099-01-01', VERSION_VERIFICACION_ALIAS)).toBe(false);
    // Lo que se le cuenta a la empresa coincide con lo que hace el código: ya no hay control del
    // turno, y la vigente dice lo mismo que 2026-10-06.
    expect(CONDICIONES_VIGENTES.puntos.join(' ')).not.toMatch(/turno/i);
    expect(CONDICIONES_VIGENTES.puntos).toEqual(condicionesDeVersion('2026-10-06')!.puntos);
  });

  test('quien aceptó 2026-10-06 o 2026-11-13 está al día: no se le vuelve a pedir', async () => {
    for (const version of ['2026-10-06', '2026-11-13', CONDICIONES_VIGENTES.version]) {
      const { s } = servicio({ empresaId: 'e1', mpUserId: '111', estado: 'ACTIVA', condicionesVersion: version });
      await expect(como(() => s.estado())).resolves.toMatchObject({ condicionesAceptadas: { alDia: true } });
    }
    const { s } = servicio({ empresaId: 'e1', mpUserId: '111', estado: 'ACTIVA', condicionesVersion: '2026-10-05' });
    await expect(como(() => s.estado())).resolves.toMatchObject({ condicionesAceptadas: { alDia: false } });
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
