import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { tenantContext, type TenantScope } from 'src/tenancy/tenant-context';
import { TipoVehiculoService } from './tipo-vehiculo.service';

const foto = { buffer: Buffer.from('jpeg'), size: 4, mimetype: 'image/jpeg', originalname: 'auto.jpg' } as Express.Multer.File;
const TIPOS = [
  { code: 'AUTO', name: 'Auto', enabled: true },
  { code: 'CAMIONETA', name: 'Camioneta', enabled: true },
  { code: 'MOTO', name: 'Moto', enabled: true },
];
const CON_COBRO: TenantScope = { empresaId: 'e', playaId: 'p', userId: 'u', role: 'USER', modalidad: 'CON_COBRO' };

const respuestaGemini = (tipo: string, modelo = '') => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ tipo, modelo }) }] }, finishReason: 'STOP' }] });

describe('TipoVehiculoService', () => {
  const find = jest.fn();
  const config = new Map<string, string>();
  const service = new TipoVehiculoService(
    { getRepository: () => ({ find }) } as unknown as DataSource,
    { get: (clave: string) => config.get(clave) } as unknown as ConfigService,
  );
  const detectar = (scope: TenantScope = CON_COBRO) => tenantContext.run(scope, () => service.detectar(foto));
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
    find.mockReset().mockResolvedValue(TIPOS);
    config.clear();
    config.set('GEMINI_API_KEY', 'clave');
  });

  it('sin playa no consulta a Gemini', async () => {
    await expect(service.detectar(foto)).rejects.toThrow('Elegí una playa');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('en las dos modalidades devuelve el tipo y el modelo según Gemini', async () => {
    fetchMock.mockResolvedValue(respuestaGemini('CAMIONETA', '  Fiat   Strada <b>'));
    await expect(detectar()).resolves.toEqual({ vehicleType: 'CAMIONETA', modelo: 'Fiat Strada b' });
    fetchMock.mockResolvedValue(respuestaGemini('MOTO', 'Honda Wave 110'));
    await expect(detectar({ ...CON_COBRO, modalidad: 'GRATUITO' })).resolves.toEqual({ vehicleType: 'MOTO', modelo: 'Honda Wave 110' });

    const [url, pedido] = fetchMock.mock.calls[0];
    expect(url).toContain('generativelanguage.googleapis.com');
    const cuerpo = JSON.parse(pedido.body);
    // La foto va en el pedido y el tipo queda limitado a los habilitados de la playa.
    expect(cuerpo.contents[0].parts[0].inlineData).toEqual({ mimeType: 'image/jpeg', data: Buffer.from('jpeg').toString('base64') });
    expect(cuerpo.generationConfig.responseSchema.properties.tipo.enum).toEqual(['AUTO', 'CAMIONETA', 'MOTO', 'NINGUNO']);
  });

  it('si Gemini no sabe, falla o no está configurado, no sugiere nada', async () => {
    fetchMock.mockResolvedValue(respuestaGemini('NINGUNO'));
    await expect(detectar()).resolves.toEqual({ vehicleType: null, modelo: null });

    fetchMock.mockResolvedValue(respuestaGemini('OTRO', 'Fiat Uno'));
    await expect(detectar()).resolves.toEqual({ vehicleType: null, modelo: 'Fiat Uno' });

    fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(detectar()).resolves.toEqual({ vehicleType: null, modelo: null });

    config.clear();
    fetchMock.mockClear();
    await expect(detectar()).resolves.toEqual({ vehicleType: null, modelo: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('una playa sin tipos habilitados no consulta', async () => {
    find.mockResolvedValue([]);
    await expect(detectar()).resolves.toEqual({ vehicleType: null, modelo: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
