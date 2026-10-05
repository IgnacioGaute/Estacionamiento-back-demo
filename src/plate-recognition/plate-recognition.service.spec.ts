import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PLATE_IMAGE_MAX_BYTES, PlateRecognitionService } from './plate-recognition.service';

const foto = (size: number) =>
  ({ buffer: Buffer.alloc(size), size, mimetype: 'image/jpeg', originalname: 'patente.jpg' }) as Express.Multer.File;

describe('PlateRecognitionService', () => {
  const service = new PlateRecognitionService({ get: () => 'clave' } as unknown as ConfigService);
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  it('rechaza una foto de más de 3 MB sin llamar a Plate Recognizer', async () => {
    await expect(service.recognize(foto(PLATE_IMAGE_MAX_BYTES + 1))).rejects.toMatchObject({
      response: { code: 'PLATE_IMAGE_TOO_LARGE' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('traduce el 413 de Plate Recognizer al mismo error de foto pesada', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 413 }));
    await expect(service.recognize(foto(1000))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('devuelve solo la patente y el puntaje, pidiendo formatos argentinos', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ results: [{ plate: 'ab123cd', score: 0.9, box: {}, region: {} }] }),
    );
    await expect(service.recognize(foto(PLATE_IMAGE_MAX_BYTES))).resolves.toEqual({
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
    await expect(service.recognize(foto(1000))).resolves.toEqual({ plate: 'AB123CD', score: 0.9 });
  });

  describe('tope por segundo (429)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('reintenta una vez pasado el segundo', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('', { status: 429 }))
        .mockResolvedValueOnce(Response.json({ results: [{ plate: 'abc123', score: 0.95 }] }));
      const resultado = service.recognize(foto(1000));
      await jest.advanceTimersByTimeAsync(1000);
      await expect(resultado).resolves.toEqual({ plate: 'ABC123', score: 0.95 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('si sigue ocupado responde PLATE_RECOGNIZER_BUSY, no «cupo mensual»', async () => {
      fetchMock.mockImplementation(async () => new Response('', { status: 429 }));
      const resultado = service.recognize(foto(1000));
      const verificacion = expect(resultado).rejects.toMatchObject({
        response: { code: 'PLATE_RECOGNIZER_BUSY' },
      });
      await jest.advanceTimersByTimeAsync(1000);
      await verificacion;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
