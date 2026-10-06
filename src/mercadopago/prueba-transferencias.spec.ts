import { ForbiddenException } from '@nestjs/common';
import {
  PruebaTransferenciasService,
  ingresosDelReporte,
  leerCsv,
} from './prueba-transferencias.service';
import { CONDICIONES_VIGENTES } from './condiciones';
import { TenantScope, tenantContext } from '../tenancy/tenant-context';

const CUENTA = {
  empresaId: 'e1',
  mpUserId: '111',
  nickname: 'PRUEBA',
  estado: 'ACTIVA',
  accessToken: 'cifrado',
  condicionesVersion: CONDICIONES_VIGENTES.version,
};

const ADMIN: TenantScope = {
  empresaId: 'e1',
  playaId: 'p1',
  userId: 'u1',
  role: 'ADMIN',
};

function servicio(cuenta: Record<string, unknown> = CUENTA) {
  const tokenDeEmpresa = jest.fn().mockResolvedValue('token');
  const findOneBy = jest.fn().mockResolvedValue(cuenta);
  const s = new PruebaTransferenciasService(
    { findOneBy } as any,
    { tokenDeEmpresa } as any,
  );
  return { s, tokenDeEmpresa, findOneBy };
}

const como = <T>(scope: TenantScope, hacer: () => Promise<T>) =>
  tenantContext.run(scope, hacer);

describe('Prueba de transferencias', () => {
  afterEach(() => jest.restoreAllMocks());

  test('el super admin y el operador no la pueden usar, ni con una empresa elegida', async () => {
    const fuera: TenantScope[] = [
      { ...ADMIN, role: 'SUPER_ADMIN', platform: true },
      { ...ADMIN, role: 'SUPER_ADMIN' },
      { ...ADMIN, role: 'USER' },
    ];
    for (const scope of fuera) {
      const { s, tokenDeEmpresa, findOneBy } = servicio();
      const fetch = jest.spyOn(global, 'fetch');
      await expect(como(scope, () => s.ingresos(5))).rejects.toMatchObject({
        response: { code: 'SOLO_LA_EMPRESA' },
      });
      expect(findOneBy).not.toHaveBeenCalled();
      expect(tokenDeEmpresa).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
    // Fuera de un pedido (sin alcance) tampoco.
    await expect(servicio().s.reporte()).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  test('sin las condiciones vigentes aceptadas contesta 403 sin pedir el token', async () => {
    for (const condicionesVersion of [null, '2020-01-01']) {
      const { s, tokenDeEmpresa } = servicio({ ...CUENTA, condicionesVersion });
      const fetch = jest.spyOn(global, 'fetch');
      await expect(como(ADMIN, () => s.reporte())).rejects.toMatchObject({
        response: { code: 'CONDICIONES_SIN_ACEPTAR' },
      });
      expect(tokenDeEmpresa).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  test('consulta siempre la cuenta de la empresa de la sesión', async () => {
    const { s, findOneBy, tokenDeEmpresa } = servicio();
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    await como(ADMIN, () => s.ingresos(5));
    expect(findOneBy).toHaveBeenCalledWith({ empresaId: 'e1' });
    expect(tokenDeEmpresa).toHaveBeenCalledWith('e1');
  });

  test('muestra solo lo que entró a la cuenta y cuenta lo que salió', async () => {
    const { s } = servicio();
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          paging: { total: 3 },
          results: [
            {
              id: 1,
              collector_id: 111,
              transaction_amount: 10,
              operation_type: 'money_transfer',
              payer: {
                first_name: 'Ana',
                identification: { type: 'DNI', number: '1' },
              },
            },
            {
              id: 2,
              collector_id: 555,
              transaction_amount: 3490,
              operation_type: 'recurring_payment',
            },
            // Una suscripción que paga la cuenta: sin cobrador, pero el pagador es ella.
            {
              id: 4,
              transaction_amount: 3490,
              operation_type: 'recurring_payment',
              payer: { id: 111 },
            },
            // Una transferencia al CVU con el nombre en los datos bancarios.
            {
              id: 5,
              collector_id: 111,
              transaction_amount: 15,
              operation_type: 'account_fund',
              description: 'Alquiler cochera',
              transaction_details: { bank_transfer_id: 987 },
              point_of_interaction: {
                type: 'PSP_TRANSFER',
                transaction_data: {
                  bank_info: {
                    payer: {
                      account_holder_name: 'Juan Pérez',
                      long_name: 'Banco X',
                    },
                  },
                },
              },
            },
            { id: 3, transaction_amount: 11 },
          ],
        }),
        { status: 200 },
      ),
    );
    const r = await como(ADMIN, () => s.ingresos(5));
    expect(String(fetch.mock.calls[0][0])).toContain('/v1/payments/search?');
    if (r.pagos.ok === false) throw new Error('debería haber respondido');
    expect(r.pagos.egresosOmitidos).toBe(2);
    expect(r.pagos.items.map((p) => [p.id, p.recibido])).toEqual([
      [1, true],
      [5, true],
      // Sin cobrador ni pagador no se sabe: se muestra marcado como dudoso, no se descarta.
      [3, null],
    ]);
    expect(r.pagos.items[0].pagador).toEqual({
      nombre: 'Ana',
      documento: 'DNI 1',
      entidad: null,
    });
    expect(r.pagos.items[1]).toMatchObject({
      descripcion: 'Alquiler cochera',
      idTransferencia: 987,
      pagador: { nombre: 'Juan Pérez', entidad: 'Banco X' },
    });
  });

  test('un error de MercadoPago se informa como error, no como «sin pagos»', async () => {
    const { s } = servicio();
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'forbidden', message: 'nope' }), {
        status: 403,
      }),
    );
    const r = await como(ADMIN, () => s.ingresos(30));
    expect(r.pagos).toEqual({
      ok: false,
      estado: 403,
      error: 'forbidden: nope',
    });
  });

  test('lee el CSV con comillas, BOM, CRLF y separador punto y coma', () => {
    expect(leerCsv('﻿A;B\r\n"x;1";"di ""y"""\r\n')).toEqual({
      columnas: ['A', 'B'],
      filas: [{ A: 'x;1', B: 'di "y"' }],
    });
    expect(leerCsv('A,B\n1,2\n\n').filas).toEqual([{ A: '1', B: '2' }]);
  });

  test('del reporte quedan solo los ingresos aprobados, con columnas acotadas', () => {
    const csv = [
      'SOURCE_ID,TRANSACTION_TYPE,TRANSACTION_AMOUNT,PAYER_NAME,CARD_INITIAL_NUMBER',
      '1,SETTLEMENT,10.00,"Pérez, Ana",450799',
      '2,WITHDRAWAL,-500.00,,',
      '3,REFUND,-10.00,,',
      '4,SETTLEMENT,11.00,Juan,',
    ].join('\n');
    const r = ingresosDelReporte(csv);
    expect(r.totalFilas).toBe(4);
    expect(r.ingresos).toEqual([
      {
        SOURCE_ID: '1',
        TRANSACTION_TYPE: 'SETTLEMENT',
        TRANSACTION_AMOUNT: '10.00',
        PAYER_NAME: 'Pérez, Ana',
      },
      {
        SOURCE_ID: '4',
        TRANSACTION_TYPE: 'SETTLEMENT',
        TRANSACTION_AMOUNT: '11.00',
        PAYER_NAME: 'Juan',
      },
    ]);
  });

  test('si el reporte no permite separar ingresos, no devuelve filas', () => {
    const r = ingresosDelReporte('Tipo,Monto\nSETTLEMENT,10\n');
    expect(r).toMatchObject({
      reconocible: false,
      totalFilas: 1,
      ingresos: [],
    });
  });

  test.each([',', ';'])(
    'lee PAYER_NAME con separador %s y conserva el nombre junto a su operación',
    (sep) => {
      const csv =
        '\uFEFF' +
        [
          [
            'SOURCE_ID',
            'TRANSACTION_TYPE',
            'TRANSACTION_AMOUNT',
            'PAYER_NAME',
          ].join(sep),
          ['123', 'SETTLEMENT', '10.00', '"Pérez, Ana"'].join(sep),
          ['124', 'SETTLEMENT', '10.00', '""'].join(sep),
        ].join('\r\n');
      const r = ingresosDelReporte(csv);
      expect(r.columnas).toContain('PAYER_NAME');
      expect(r.ingresos.map((f) => [f.SOURCE_ID, f.PAYER_NAME])).toEqual([
        ['123', 'Pérez, Ana'],
        ['124', ''],
      ]);
    },
  );

  test('distingue la columna PAYER_NAME ausente de un nombre vacío', () => {
    const r = ingresosDelReporte(
      'SOURCE_ID,TRANSACTION_TYPE,TRANSACTION_AMOUNT\n123,SETTLEMENT,10',
    );
    expect(r.columnas).not.toContain('PAYER_NAME');
    expect(r.ingresos[0]).not.toHaveProperty('PAYER_NAME');
  });
});
