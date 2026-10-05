import { ForbiddenException } from '@nestjs/common';
import {
  PruebaTransferenciasService,
  ingresosDelReporte,
  leerCsv,
} from './prueba-transferencias.service';

const CUENTA = {
  empresaId: 'e1',
  mpUserId: '111',
  nickname: 'PRUEBA',
  estado: 'ACTIVA',
  accessToken: 'cifrado',
};

function servicio(autorizadas: string | undefined, cuenta = CUENTA) {
  const tokenDeEmpresa = jest.fn().mockResolvedValue('token');
  const s = new PruebaTransferenciasService(
    { findOneBy: jest.fn().mockResolvedValue(cuenta) } as any,
    { tokenDeEmpresa } as any,
    { get: () => autorizadas } as any,
  );
  return { s, tokenDeEmpresa };
}

describe('Prueba de transferencias', () => {
  afterEach(() => jest.restoreAllMocks());

  test('con una cuenta no autorizada contesta 403 sin pedir el token', async () => {
    for (const autorizadas of [undefined, '', '222, 333']) {
      const { s, tokenDeEmpresa } = servicio(autorizadas);
      const fetch = jest.spyOn(global, 'fetch');
      await expect(s.ingresos('e1', 5)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(s.reporte('e1')).rejects.toMatchObject({
        response: { code: 'PRUEBA_NO_AUTORIZADA' },
      });
      expect(tokenDeEmpresa).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  test('muestra solo lo que entró a la cuenta y cuenta lo que salió', async () => {
    const { s } = servicio('999, 111');
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
            { id: 3, transaction_amount: 11 },
          ],
        }),
        { status: 200 },
      ),
    );
    const r = await s.ingresos('e1', 5);
    expect(String(fetch.mock.calls[0][0])).toContain('/v1/payments/search?');
    if (r.pagos.ok === false) throw new Error('debería haber respondido');
    expect(r.pagos.egresosOmitidos).toBe(1);
    expect(r.pagos.items.map((p) => [p.id, p.recibido])).toEqual([
      [1, true],
      // Sin collector_id no se sabe: se muestra marcado como dudoso, no se descarta.
      [3, null],
    ]);
    expect(r.pagos.items[0].pagador).toEqual({
      nombre: 'Ana',
      documento: 'DNI 1',
    });
  });

  test('un error de MercadoPago se informa como error, no como «sin pagos»', async () => {
    const { s } = servicio('111');
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'forbidden', message: 'nope' }), {
        status: 403,
      }),
    );
    const r = await s.ingresos('e1', 30);
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
});
