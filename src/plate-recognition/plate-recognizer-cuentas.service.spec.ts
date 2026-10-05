import { DataSource } from 'typeorm';
import { cifrarToken, descifrarToken } from 'src/mercadopago/token-crypto';
import { PlateRecognizerCuentasService } from './plate-recognizer-cuentas.service';

const estadisticas = (usadas: number, total = 2500) =>
  Response.json({ total_calls: total, usage: { calls: usadas, resets_on: '2026-10-24T19:34:43Z' } });

describe('PlateRecognizerCuentasService', () => {
  const query = jest.fn();
  const service = new PlateRecognizerCuentasService({ query } as unknown as DataSource);
  const fetchMock = jest.fn();
  const claveOriginal = process.env.MERCADOPAGO_TOKEN_KEY;

  beforeAll(() => {
    process.env.MERCADOPAGO_TOKEN_KEY = 'a'.repeat(64);
  });
  afterAll(() => {
    process.env.MERCADOPAGO_TOKEN_KEY = claveOriginal;
  });
  beforeEach(() => {
    query.mockReset();
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  it('consulta una vez por cuenta y marca las playas que la comparten', async () => {
    query.mockResolvedValue([
      { id: 'p1', nombre: 'Centro', token: cifrarToken('tokenA'), huella: 'hA', terminaEn: 'enA' },
      { id: 'p2', nombre: 'Norte', token: cifrarToken('tokenA'), huella: 'hA', terminaEn: 'enA' },
      { id: 'p3', nombre: 'Sur', token: null, huella: null, terminaEn: null },
    ]);
    fetchMock.mockResolvedValue(estadisticas(1200));

    const consumo = await service.consumoDeEmpresa('e1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(consumo[0]).toEqual({
      playaId: 'p1',
      nombre: 'Centro',
      configurado: true,
      terminaEn: 'enA',
      uso: { usadas: 1200, total: 2500, restantes: 1300, seRenueva: '2026-10-24T19:34:43Z' },
      compartidaCon: ['Norte'],
    });
    expect(consumo[1].compartidaCon).toEqual(['Centro']);
    expect(consumo[2]).toEqual({ playaId: 'p3', nombre: 'Sur', configurado: false });
  });

  it('si Plate Recognizer rechaza una cuenta, esa playa muestra el error y las demás siguen', async () => {
    query.mockResolvedValue([
      { id: 'p1', nombre: 'Centro', token: cifrarToken('vencido'), huella: 'h1', terminaEn: 'cido' },
      { id: 'p2', nombre: 'Norte', token: cifrarToken('bueno'), huella: 'h2', terminaEn: 'ueno' },
    ]);
    fetchMock.mockImplementation(async (_url, init) =>
      init.headers.Authorization === 'Token vencido'
        ? Response.json({ detail: 'Invalid token.' }, { status: 403 })
        : estadisticas(10),
    );

    const [centro, norte] = await service.consumoDeEmpresa('e1');

    expect(centro.error).toMatch(/no acepta ese token/);
    expect(centro.uso).toBeUndefined();
    expect(norte.uso?.restantes).toBe(2490);
  });

  it('no guarda un token que Plate Recognizer rechaza', async () => {
    query.mockResolvedValueOnce([{ id: 'p1', nombre: 'Centro', empresaId: 'e1' }]);
    fetchMock.mockResolvedValue(Response.json({ detail: 'Invalid token.' }, { status: 403 }));

    await expect(service.configurar('p1', 'malo', 'u1')).rejects.toMatchObject({
      response: { code: 'PLATE_RECOGNIZER_TOKEN_INVALIDO' },
    });
    expect(query).toHaveBeenCalledTimes(1); // solo la búsqueda de la playa, ningún INSERT
  });

  it('guarda el token cifrado, con su huella y sus últimos cuatro caracteres', async () => {
    query.mockResolvedValueOnce([{ id: 'p1', nombre: 'Centro', empresaId: 'e1' }]).mockResolvedValueOnce([]);
    fetchMock.mockResolvedValue(estadisticas(0));

    const { uso } = await service.configurar('p1', '  abcdef123456  ', 'u1');

    expect(uso.restantes).toBe(2500);
    const [, [playaId, guardado, huella, terminaEn, usuario]] = query.mock.calls[1];
    expect(playaId).toBe('p1');
    expect(guardado).not.toContain('abcdef123456');
    expect(descifrarToken(guardado)).toBe('abcdef123456');
    expect(huella).toMatch(/^[0-9a-f]{64}$/);
    expect(terminaEn).toBe('3456');
    expect(usuario).toBe('u1');
  });
});
