import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const PLATE_RECOGNIZER_URL = 'https://api.platerecognizer.com/v1/plate-reader/';
// Límite de Snapshot Cloud. Una foto de celular sin achicar lo supera casi siempre (el front la
// reduce antes de subirla); se corta acá para no gastar un viaje que Plate Recognizer va a rechazar.
export const PLATE_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const FOTO_PESADA = {
  code: 'PLATE_IMAGE_TOO_LARGE',
  message: 'La foto es demasiado pesada para reconocer la patente. Probá de nuevo o escribila manualmente.',
};

export type PlateRecognitionResult = { plate: string | null; score?: number };

@Injectable()
export class PlateRecognitionService {
  private readonly logger = new Logger(PlateRecognitionService.name);

  constructor(private readonly configService: ConfigService) {}

  async recognize(file: Express.Multer.File): Promise<PlateRecognitionResult> {
    // Plan gratuito de Plate Recognizer: 2500 lookups/mes, sin tarjeta. No hay rate-limiting
    // propio acá — si se supera la cuota, Plate Recognizer devuelve 429 (mapeado abajo).
    const apiKey = this.configService.get<string>('PLATE_RECOGNIZER_API_KEY');
    if (!apiKey) {
      this.logger.error('PLATE_RECOGNIZER_API_KEY no configurada.');
      throw new InternalServerErrorException(
        'El reconocimiento de patente por cámara no está configurado en el servidor.',
      );
    }

    if (file.size > PLATE_IMAGE_MAX_BYTES) {
      throw new BadRequestException(FOTO_PESADA);
    }

    const formData = new FormData();
    formData.append(
      'upload',
      new Blob([file.buffer], { type: file.mimetype }),
      file.originalname || 'plate.jpg',
    );

    let response: Response;
    try {
      response = await fetch(PLATE_RECOGNIZER_URL, {
        method: 'POST',
        headers: { Authorization: `Token ${apiKey}` },
        body: formData,
      });
    } catch (error) {
      this.logger.error('Error de red llamando a Plate Recognizer', error as Error);
      throw new InternalServerErrorException(
        'No se pudo contactar el servicio de reconocimiento de patente.',
      );
    }

    if (response.status === 401 || response.status === 403) {
      this.logger.error(`Plate Recognizer rechazó la autenticación (status ${response.status}).`);
      throw new InternalServerErrorException('El servicio de reconocimiento de patente rechazó la autenticación.');
    }
    if (response.status === 413) {
      this.logger.warn(`Plate Recognizer rechazó una imagen de ${file.size} bytes por tamaño.`);
      throw new BadRequestException(FOTO_PESADA);
    }
    if (response.status === 429) {
      this.logger.warn('Plate Recognizer: límite de cuota mensual alcanzado.');
      throw new InternalServerErrorException('Se alcanzó el límite mensual de reconocimientos de patente.');
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(`Plate Recognizer respondió ${response.status}: ${body}`);
      throw new InternalServerErrorException('El servicio de reconocimiento de patente no pudo procesar la imagen.');
    }

    const data = await response.json();
    const best = data?.results?.[0];

    // Nunca se reenvía el payload completo del vendor (coordenadas, región adivinada, etc.) al
    // cliente — solo lo que la UI necesita.
    if (!best?.plate) {
      return { plate: null };
    }
    return {
      plate: String(best.plate).toUpperCase(),
      score: typeof best.score === 'number' ? best.score : undefined,
    };
  }
}
