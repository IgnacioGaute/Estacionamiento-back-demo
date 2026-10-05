import { BadRequestException } from '@nestjs/common';
import { tenantContext } from 'src/tenancy/tenant-context';
import { PLATE_IMAGE_MAX_BYTES, PlateRecognitionService } from './plate-recognition.service';
import { PlateRecognizerCuentasService } from './plate-recognizer-cuentas.service';

const foto = (size: number) =>
  ({ buffer: Buffer.alloc(size), size, mimetype: 'image/jpeg', originalname: 'patente.jpg' }) as Express.Multer.File;

const PLAYA = '11111111-1111-4111-8111-111111111111';

describe('PlateRecognitionService', () => {
  const tokenDeLaPlaya = jest.fn();
  const service = new PlateRecognitionService({ tokenDeLaPlaya } as unknown as PlateRecognizerCuentasService);
  const reconocer = (file: Express.Multer.File) =>
    tenantContext.run({ empresaId: 'e', playaId: PLAYA, userId: 'u' }, () => service.recognize(file));
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
    tokenDeLaPlaya.mockReset();
    tokenDeLaPlaya.mockResolvedValue('token-de-la-playa');
  });

  it('una playa sin plan no consulta a Plate Recognizer', async () => {
    tokenDeLaPlaya.mockResolvedValue(null);
    await expect(reconocer(foto(1000))).rejects.toMatchObject({ response: { code: 'PATENTES_SIN_PLAN' } });
    expect(tokenDeLaPlaya).toHaveBeenCalledWith(PLAYA);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('consulta con el token de la playa, no con uno de la plataforma', async () => {
    fetchMock.mockResolvedValue(Response.json({ results: [] }));
    await expect(reconocer(foto(1000))).resolves.toEqual({ plate: null });
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: 'Token token-de-la-playa' });
  });

  it('rechaza una foto de más de 3 MB sin llamar a Plate Recognizer', async () => {
    await expect(reconocer(foto(PLATE_IMAGE_MAX_BYTES + 1))).rejects.toMatchObject({
      response: { code: 'PLATE_IMAGE_TOO_LARGE' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('traduce el 413 de Plate Recognizer al mismo error de foto pesada', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 413 }));
    await expect(reconocer(foto(1000))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('devuelve solo la patente y el puntaje, pidiendo formatos argentinos', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ results: [{ plate: 'ab123cd', score: 0.9, box: {}, region: {} }] }),
    );
    await expect(reconocer(foto(PLATE_IMAGE_MAX_BYTES))).resolves.toEqual({
      plate: 'AB123CD',
      score: 0.9,
    });
    expect((fetchMock.mock.calls[0][1].body as FormData).get('regions')).toBe('ar');
  });

  it('con varias patentes en la imagen elige la más cercana al centro', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        image_width: 1000,
        image_height: 600,
        results: [
          { plate: 'zzz999', score: 0.99, box: { xmin: 20, ymin: 20, xmax: 180, ymax: 70 } },
          { plate: 'ab123cd', score: 0.9, box: { xmin: 420, ymin: 280, xmax: 580, ymax: 330 } },
        ],
      }),
    );
    await expect(reconocer(foto(1000))).resolves.toEqual({ plate: 'AB123CD', score: 0.9 });
  });

  describe('tope por segundo (429)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('reintenta una vez pasado el segundo', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('', { status: 429 }))
        .mockResolvedValueOnce(Response.json({ results: [{ plate: 'abc123', score: 0.95 }] }));
      const resultado = reconocer(foto(1000));
      await jest.advanceTimersByTimeAsync(1000);
      await expect(resultado).resolves.toEqual({ plate: 'ABC123', score: 0.95 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('si sigue ocupado responde PLATE_RECOGNIZER_BUSY, no «cupo mensual»', async () => {
      fetchMock.mockImplementation(async () => new Response('', { status: 429 }));
      const resultado = reconocer(foto(1000));
      const verificacion = expect(resultado).rejects.toMatchObject({
        response: { code: 'PLATE_RECOGNIZER_BUSY' },
      });
      await jest.advanceTimersByTimeAsync(1000);
      await verificacion;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
