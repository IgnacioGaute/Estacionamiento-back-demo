import { BadRequestException } from '@nestjs/common';
import { CobrosMercadoPagoService } from './cobros.service';
import { CajasQrService } from './cajas-qr.service';
import { TenantScope, tenantContext } from '../tenancy/tenant-context';

const SCOPE: TenantScope = {
  empresaId: 'e1',
  playaId: 'p1',
  userId: 'u1',
  role: 'USER',
};
const en = <T>(fn: () => Promise<T>) => tenantContext.run(SCOPE, fn);

// Un repositorio en memoria con lo que usa CobrosMercadoPagoService.
function repoDeCobros() {
  const filas = new Map<string, any>();
  let n = 0;
  const coincide = (f: any, where: any) =>
    Object.entries(where).every(([k, v]) => f[k] === v);
  return {
    filas,
    create: (d: any) => ({ ...d }),
    save: async (d: any) => {
      d.id ??= `cobro-${++n}`;
      filas.set(d.id, { ...filas.get(d.id), ...d });
      return filas.get(d.id);
    },
    findOneBy: async (where: any) =>
      [...filas.values()].find((f) => coincide(f, where)) ?? null,
    findBy: async (where: any) =>
      [...filas.values()].filter((f) => coincide(f, where)),
    update: async (where: any, cambios: any) => {
      let affected = 0;
      for (const f of filas.values())
        if (coincide(f, where)) {
          Object.assign(f, cambios);
          affected++;
        }
      return { affected };
    },
  };
}

function cobrosConCaja(caja: object | null, crearOrden?: jest.Mock) {
  const cobros = repoDeCobros();
  const mercadoPago = {
    crearPreferencia: jest.fn().mockResolvedValue({
      preferenceId: 'pref-1',
      initPoint: 'https://mp/link',
    }),
    buscarPagoAprobado: jest.fn().mockResolvedValue(null),
  };
  const tickets = {
    getCloseSummary: jest.fn().mockResolvedValue({
      saldoACobrar: 1500,
      registration: { licensePlateOriginal: 'AB123CD' },
    }),
    registrarPagoExterno: jest.fn().mockResolvedValue({}),
  };
  const cajasQr = {
    cajaDePlaya: jest.fn().mockResolvedValue(caja),
    crearOrden:
      crearOrden ??
      jest
        .fn()
        .mockResolvedValue({ ordenId: 'ORD1', qrData: '000201QR-ESTANDAR' }),
    consultarOrden: jest.fn(),
    cancelarOrden: jest.fn().mockResolvedValue(undefined),
  };
  const servicio = new CobrosMercadoPagoService(
    cobros as any,
    mercadoPago as any,
    tickets as any,
    { get: () => '' } as any,
    {} as any,
    cajasQr as any,
  );
  return { servicio, cobros, mercadoPago, tickets, cajasQr };
}

describe('Cobro con QR por caja de la playa', () => {
  test('con caja genera la orden con el QR estándar y no el link', async () => {
    const { servicio, mercadoPago, cajasQr } = cobrosConCaja({
      externalPosId: 'CAJA1',
    });
    const cobro = await en(() => servicio.crear('reg-1', 'HORA', 'u1'));
    expect(cajasQr.crearOrden).toHaveBeenCalledWith(
      'e1',
      { externalPosId: 'CAJA1' },
      expect.objectContaining({
        monto: 1500,
        referencia: cobro.id,
        minutos: 15,
      }),
    );
    expect(mercadoPago.crearPreferencia).not.toHaveBeenCalled();
    expect(cobro).toMatchObject({
      qr: '000201QR-ESTANDAR',
      interoperable: true,
    });
  });

  test('si la orden falla, cobra igual con el link de siempre', async () => {
    const falla = jest
      .fn()
      .mockRejectedValue(new BadRequestException('caja rota'));
    const { servicio, mercadoPago } = cobrosConCaja(
      { externalPosId: 'CAJA1' },
      falla,
    );
    const cobro = await en(() => servicio.crear('reg-1', 'HORA', 'u1'));
    expect(mercadoPago.crearPreferencia).toHaveBeenCalledTimes(1);
    expect(cobro).toMatchObject({
      qr: 'https://mp/link',
      interoperable: false,
    });
  });

  test('sin caja en la playa usa el link', async () => {
    const { servicio, cajasQr } = cobrosConCaja(null);
    const cobro = await en(() => servicio.crear('reg-1', 'HORA', 'u1'));
    expect(cajasQr.crearOrden).not.toHaveBeenCalled();
    expect(cobro.interoperable).toBe(false);
  });

  test('se acredita una sola vez cuando la orden figura pagada', async () => {
    const { servicio, cajasQr, tickets, mercadoPago } = cobrosConCaja({
      externalPosId: 'CAJA1',
    });
    const cobro = await en(() => servicio.crear('reg-1', 'HORA', 'u1'));
    cajasQr.consultarOrden.mockResolvedValue({
      estado: 'created',
      pagada: false,
      pagoId: null,
      monto: 0,
    });
    expect((await en(() => servicio.consultar(cobro.id))).estado).toBe(
      'PENDIENTE',
    );
    cajasQr.consultarOrden.mockResolvedValue({
      estado: 'processed',
      pagada: true,
      pagoId: 'PAY1',
      monto: 1500,
    });
    expect((await en(() => servicio.consultar(cobro.id))).estado).toBe(
      'ACREDITADO',
    );
    await en(() => servicio.consultar(cobro.id));
    expect(tickets.registrarPagoExterno).toHaveBeenCalledTimes(1);
    expect(tickets.registrarPagoExterno).toHaveBeenCalledWith(
      'reg-1',
      1500,
      'MERCADOPAGO',
      'MercadoPago PAY1',
      'u1',
    );
    expect(mercadoPago.buscarPagoAprobado).not.toHaveBeenCalled();
  });

  test('cancelar o generar otro QR cancela la orden en MercadoPago', async () => {
    const { servicio, cajasQr } = cobrosConCaja({ externalPosId: 'CAJA1' });
    const primero = await en(() => servicio.crear('reg-1', 'HORA', 'u1'));
    await en(() => servicio.crear('reg-1', 'HORA', 'u1'));
    expect(cajasQr.cancelarOrden).toHaveBeenCalledWith('e1', 'ORD1');
    expect((await en(() => servicio.consultar(primero.id))).estado).toBe(
      'CANCELADO',
    );
  });
});

describe('Sucursal y caja de una playa', () => {
  afterEach(() => jest.restoreAllMocks());

  function cajas() {
    const guardadas: any[] = [];
    const servicio = new CajasQrService(
      {
        findOneBy: jest.fn().mockResolvedValue(null),
        findBy: jest.fn().mockResolvedValue([]),
        create: (d: any) => d,
        save: jest.fn(async (d: any) => guardadas.push(d)),
      } as any,
      {
        findOneBy: jest.fn().mockResolvedValue({
          empresaId: 'e1',
          mpUserId: '111',
          estado: 'ACTIVA',
        }),
      } as any,
      { tokenDeEmpresa: jest.fn().mockResolvedValue('token') } as any,
      {
        getRepository: () => ({
          findOneBy: jest.fn().mockResolvedValue({
            id: 'p1',
            nombre: 'Playa Centro',
            empresaId: 'e1',
          }),
          find: jest.fn().mockResolvedValue([]),
        }),
      } as any,
    );
    return { servicio, guardadas };
  }
  const direccion = {
    calle: 'San Martín',
    numero: '123',
    ciudad: 'Rosario',
    provincia: 'Santa Fe',
    latitud: -32.95,
    longitud: -60.65,
  };
  const json = (cuerpo: unknown, status = 200) =>
    new Response(JSON.stringify(cuerpo), { status });

  test('crea la sucursal y la caja con la dirección y guarda sus ids', async () => {
    const { servicio, guardadas } = cajas();
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(json({ results: [] }))
      .mockResolvedValueOnce(json({ id: 555 }))
      .mockResolvedValueOnce(json({ results: [] }))
      .mockResolvedValueOnce(json({ id: 777 }));
    await en(() => servicio.crear('p1', direccion, 'u1'));
    const sucursal = JSON.parse(String(fetch.mock.calls[1][1]?.body));
    expect(String(fetch.mock.calls[1][0])).toBe(
      'https://api.mercadopago.com/users/111/stores',
    );
    expect(sucursal.location).toMatchObject({
      street_name: 'San Martín',
      street_number: '123',
      city_name: 'Rosario',
      state_name: 'Santa Fe',
      latitude: -32.95,
      longitude: -60.65,
    });
    const caja = JSON.parse(String(fetch.mock.calls[3][1]?.body));
    expect(caja).toMatchObject({
      store_id: 555,
      external_store_id: sucursal.external_id,
      fixed_amount: true,
    });
    expect(guardadas[0]).toMatchObject({
      playaId: 'p1',
      storeId: '555',
      posId: '777',
      externalPosId: caja.external_id,
    });
  });

  test('si la sucursal y la caja ya existían (intento cortado), las reusa', async () => {
    const { servicio, guardadas } = cajas();
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(json({ results: [{ id: 555 }] }))
      .mockResolvedValueOnce(json({ results: [{ id: 777 }] }));
    await en(() => servicio.crear('p1', direccion, 'u1'));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(guardadas[0]).toMatchObject({ storeId: '555', posId: '777' });
  });

  test('si MercadoPago rechaza la dirección, devuelve su motivo', async () => {
    const { servicio, guardadas } = cajas();
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(json({ results: [] }))
      .mockResolvedValueOnce(
        json(
          {
            message: 'invalid location',
            cause: [{ description: 'state_name inválido' }],
          },
          400,
        ),
      );
    await expect(
      en(() => servicio.crear('p1', direccion, 'u1')),
    ).rejects.toThrow(/invalid location · state_name inválido/);
    expect(guardadas).toHaveLength(0);
  });

  test('la orden pide QR dinámico para la caja, con la referencia como clave de idempotencia', async () => {
    const { servicio } = cajas();
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        json({ id: 'ORD9', type_response: { qr_data: '000201ABC' } }),
      );
    const r = await servicio.crearOrden(
      'e1',
      { externalPosId: 'CAJA1' } as any,
      {
        monto: 1500,
        referencia: 'cobro-9',
        descripcion: 'Estacionamiento - AB123CD',
        minutos: 15,
      },
    );
    expect(r).toEqual({ ordenId: 'ORD9', qrData: '000201ABC' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.mercadopago.com/v1/orders');
    expect((init?.headers as any)['X-Idempotency-Key']).toBe('cobro-9');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      type: 'qr',
      external_reference: 'cobro-9',
      expiration_time: 'PT15M',
      config: { qr: { external_pos_id: 'CAJA1', mode: 'dynamic' } },
    });
  });
});
