import { ConfigService } from '@nestjs/config';
import { CAJA_QR_PLATAFORMA, MercadoPagoPlataforma, SUCURSAL_QR_PLATAFORMA } from './mercadopago-plataforma';

// El QR para pagar el plan, contra una API de MercadoPago simulada: qué se le pide y con qué
// identificadores, siempre con el token de la plataforma.
class SinEspera extends MercadoPagoPlataforma {
  protected esperar() {
    return Promise.resolve();
  }
}

const direccion = { calle: 'Mitre', numero: '1543', ciudad: 'Rosario', provincia: 'Santa Fe', latitud: -32.95, longitud: -60.64 };

describe('MercadoPagoPlataforma: QR del plan', () => {
  const mp = new SinEspera({ get: (k: string) => ({ MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN: 'token-plataforma' })[k] } as unknown as ConfigService);
  const fetchMock = jest.fn();
  const responde = (status: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status });
  const pedidos = () => fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), metodo: init?.method ?? 'GET', cuerpo: init?.body ? JSON.parse(init.body) : null, headers: init?.headers ?? {} }));

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  it('sin caja creada (MercadoPago responde 404 a la búsqueda) no hay QR', async () => {
    fetchMock.mockResolvedValueOnce(responde(404, { message: 'not found' }));
    await expect(mp.cajaQr()).resolves.toBeNull();
    expect(pedidos()[0].url).toBe(`https://api.mercadopago.com/v2/pos?external_id=${CAJA_QR_PLATAFORMA}`);
    expect(pedidos()[0].headers.authorization).toBe('Bearer token-plataforma');
  });

  it('crea la sucursal y la caja con sus identificadores fijos, reintentando si la sucursal todavía no está', async () => {
    fetchMock
      .mockResolvedValueOnce(responde(200, { id: 555 }))
      .mockResolvedValueOnce(responde(404, {}))
      .mockResolvedValueOnce(responde(201, { id: 'store-9', external_id: SUCURSAL_QR_PLATAFORMA }))
      .mockResolvedValueOnce(responde(404, {}))
      .mockResolvedValueOnce(responde(400, { message: 'store_not_found' }))
      .mockResolvedValueOnce(responde(201, { id: 'pos-1' }));
    await mp.crearCajaQr(direccion, 'Sistema de estacionamiento');
    const [yo, buscarSucursal, sucursal, buscarCaja, cajaFallida, caja] = pedidos();
    expect(yo.url).toBe('https://api.mercadopago.com/users/me');
    expect(buscarSucursal.url).toContain(`/users/555/stores/search?external_id=${SUCURSAL_QR_PLATAFORMA}`);
    expect(sucursal.cuerpo).toMatchObject({ external_id: SUCURSAL_QR_PLATAFORMA, location: { street_name: 'Mitre', city_name: 'Rosario', state_name: 'Santa Fe' } });
    expect(buscarCaja.url).toContain(`external_id=${CAJA_QR_PLATAFORMA}`);
    expect(cajaFallida.cuerpo).toMatchObject({ store_id: 'store-9', external_id: CAJA_QR_PLATAFORMA });
    // El reintento usa la misma clave: no puede quedar una caja duplicada.
    expect(caja.headers['X-Idempotency-Key']).toBe(cajaFallida.headers['X-Idempotency-Key']);
  });

  it('un rechazo de la sucursal explica el motivo de MercadoPago', async () => {
    fetchMock
      .mockResolvedValueOnce(responde(200, { id: 555 }))
      .mockResolvedValueOnce(responde(404, {}))
      .mockResolvedValueOnce(responde(400, { message: 'city_name was invalid' }));
    await expect(mp.crearCajaQr(direccion, 'Sistema')).rejects.toThrow('city_name was invalid');
  });

  it('la orden cobra en la caja de la plataforma y se lee pagada con su id de pago', async () => {
    fetchMock.mockResolvedValueOnce(responde(201, { id: 'ORD1', type_response: { qr_data: '000201abc' } }));
    await expect(mp.crearOrdenQr({ referencia: 'plan_x_20261026', descripcion: 'Plan', importe: 25000, minutos: 15, idempotencia: 'clave-1' }))
      .resolves.toEqual({ ordenId: 'ORD1', qrData: '000201abc' });
    const [orden] = pedidos();
    expect(orden.cuerpo).toMatchObject({
      type: 'qr',
      total_amount: '25000.00',
      external_reference: 'plan_x_20261026',
      expiration_time: 'PT15M',
      config: { qr: { external_pos_id: CAJA_QR_PLATAFORMA, mode: 'dynamic' } },
    });
    expect(orden.headers['X-Idempotency-Key']).toBe('clave-1');

    fetchMock.mockResolvedValueOnce(responde(200, {
      id: 'ORD1', status: 'processed', external_reference: 'plan_x_20261026',
      transactions: { payments: [{ id: 'PAY1', status: 'processed', paid_amount: '25000.00' }] },
    }));
    await expect(mp.ordenQr('ORD1')).resolves.toEqual({ id: 'ORD1', estado: 'processed', pagada: true, pagoId: 'PAY1', monto: 25000, referencia: 'plan_x_20261026' });
  });
});
