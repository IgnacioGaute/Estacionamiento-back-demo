import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { tenantContext } from 'src/tenancy/tenant-context';
import { PlateRecognizerCuentasService } from './plate-recognizer-cuentas.service';

const PLATE_RECOGNIZER_URL = 'https://api.platerecognizer.com/v1/plate-reader/';
// Límite de Snapshot Cloud. Una foto de celular sin achicar lo supera casi siempre (el front la
// reduce antes de subirla); se corta acá para no gastar un viaje que Plate Recognizer va a rechazar.
export const PLATE_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const REINTENTO_429_MS = 1000;
const FOTO_PESADA = {
  code: 'PLATE_IMAGE_TOO_LARGE',
  message: 'La foto es demasiado pesada para reconocer la patente. Probá de nuevo o escribila manualmente.',
};

export type PlateRecognitionResult = { plate: string | null; score?: number };

type LecturaVendor = {
  plate?: string;
  score?: number;
  box?: { xmin: number; ymin: number; xmax: number; ymax: number };
};

// Plate Recognizer ordena las patentes a su criterio, y con la cámara en vivo suelen entrar otras
// en el cuadro (el auto de atrás, uno estacionado). Vale la que el operador está apuntando: la
// más cercana al centro de la imagen.
function masCentrada(lecturas: LecturaVendor[], ancho?: number, alto?: number) {
  if (!(Number(ancho) > 0 && Number(alto) > 0)) return lecturas[0];
  let elegida = lecturas[0];
  let menor = Infinity;
  for (const lectura of lecturas) {
    const box = lectura?.box;
    if (!box) continue;
    const dx = (box.xmin + box.xmax) / 2 - Number(ancho) / 2;
    const dy = (box.ymin + box.ymax) / 2 - Number(alto) / 2;
    if (dx * dx + dy * dy < menor) {
      menor = dx * dx + dy * dy;
      elegida = lectura;
    }
  }
  return elegida;
}

@Injectable()
export class PlateRecognitionService {
  private readonly logger = new Logger(PlateRecognitionService.name);

  constructor(private readonly cuentas: PlateRecognizerCuentasService) {}

  async recognize(file: Express.Multer.File): Promise<PlateRecognitionResult> {
    // Cada playa usa su propia cuenta de Plate Recognizer: cada consulta descuenta de SU plan,
    // encuentre o no una patente, y el tope de consultas por segundo es el de su plan.
    const playaId = tenantContext.getStore()?.playaId;
    const apiKey = playaId ? await this.cuentas.tokenDeLaPlaya(playaId) : null;
    if (!apiKey) {
      throw new ForbiddenException({
        code: 'PATENTES_SIN_PLAN',
        message: 'Esta playa no tiene contratado el reconocimiento de patentes. Escribí la patente a mano.',
      });
    }

    if (file.size > PLATE_IMAGE_MAX_BYTES) {
      throw new BadRequestException(FOTO_PESADA);
    }

    let response = await this.consultar(apiKey, file);
    if (response.status === 429) {
      // 429 es el tope por segundo, no el cupo del mes: si otro operador escaneó en el mismo
      // segundo alcanza con esperar y reintentar una vez (lo mismo hace el cliente oficial).
      await new Promise((resolve) => setTimeout(resolve, REINTENTO_429_MS));
      response = await this.consultar(apiKey, file);
    }

    if (response.status === 401 || response.status === 403) {
      // El cuerpo dice si es el token o el plan agotado; queda en el log para el super admin.
      const body = await response.text().catch(() => '');
      this.logger.error(
        `Plate Recognizer rechazó el pedido de la playa ${playaId} (status ${response.status}): ${body}`,
      );
      throw new InternalServerErrorException(
        'Plate Recognizer rechazó el pedido: puede que se haya agotado el plan de la playa. Escribí la patente a mano.',
      );
    }
    if (response.status === 413) {
      this.logger.warn(`Plate Recognizer rechazó una imagen de ${file.size} bytes por tamaño.`);
      throw new BadRequestException(FOTO_PESADA);
    }
    if (response.status === 429) {
      this.logger.warn('Plate Recognizer: tope de consultas por segundo, aun después de reintentar.');
      throw new ServiceUnavailableException({
        code: 'PLATE_RECOGNIZER_BUSY',
        message: 'El reconocimiento de patentes está ocupado. Probá de nuevo en unos segundos.',
      });
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(`Plate Recognizer respondió ${response.status}: ${body}`);
      throw new InternalServerErrorException('El servicio de reconocimiento de patente no pudo procesar la imagen.');
    }

    const data = await response.json();
    const best = masCentrada(
      Array.isArray(data?.results) ? data.results : [],
      data?.image_width,
      data?.image_height,
    );

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

  private async consultar(apiKey: string, file: Express.Multer.File): Promise<Response> {
    const formData = new FormData();
    formData.append(
      'upload',
      new Blob([file.buffer], { type: file.mimetype }),
      file.originalname || 'plate.jpg',
    );
    // Con la región, Plate Recognizer ajusta la lectura a los formatos argentinos (AB123CD,
    // ABC123 y los de moto) en vez de devolver la secuencia de caracteres que crea ver.
    formData.append('regions', 'ar');

    try {
      return await fetch(PLATE_RECOGNIZER_URL, {
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
  }
}
