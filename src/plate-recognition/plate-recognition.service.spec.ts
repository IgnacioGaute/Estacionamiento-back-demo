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

  it('devuelve solo la patente y el puntaje', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ results: [{ plate: 'ab123cd', score: 0.9, box: {}, region: {} }] }),
    );
    await expect(service.recognize(foto(PLATE_IMAGE_MAX_BYTES))).resolves.toEqual({
      plate: 'AB123CD',
      score: 0.9,
    });
  });
});
