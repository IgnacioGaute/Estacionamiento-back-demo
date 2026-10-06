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
import { alprConfigurado } from './alpr';

const PLATE_RECOGNIZER_URL = 'https://api.platerecognizer.com/v1/plate-reader/';
// Límite de Snapshot Cloud. Una foto de celular sin achicar lo supera casi siempre (el front la
// reduce antes de subirla); se corta acá para no gastar un viaje que Plate Recognizer va a rechazar.
export const PLATE_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const REINTENTO_429_MS = 1000;
// fast-alpr en CPU tarda menos de un segundo por foto; más que esto es que el servicio no responde.
const ALPR_TIMEOUT_MS = 15_000;
const ALPR_NO_DISPONIBLE = {
  code: 'ALPR_NO_DISPONIBLE',
  message: 'El reconocimiento de patentes no responde en este momento. Escribí la patente a mano.',
};
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

// Plate Recognizer y el servicio gratuito responden con la misma forma. Nunca se reenvía el
// payload completo (coordenadas, región adivinada, etc.) al cliente: solo lo que la UI necesita.
function aResultado(data: {
  results?: unknown;
  image_width?: number;
  image_height?: number;
}): PlateRecognitionResult {
  const best = masCentrada(
    Array.isArray(data?.results) ? data.results : [],
    data?.image_width,
    data?.image_height,
  );
  if (!best?.plate) return { plate: null };
  return {
    plate: String(best.plate).toUpperCase(),
    score: typeof best.score === 'number' ? best.score : undefined,
  };
}

@Injectable()
export class PlateRecognitionService {
  private readonly logger = new Logger(PlateRecognitionService.name);

  constructor(private readonly cuentas: PlateRecognizerCuentasService) {}

  async recognize(file: Express.Multer.File): Promise<PlateRecognitionResult> {
    if (file.size > PLATE_IMAGE_MAX_BYTES) {
      throw new BadRequestException(FOTO_PESADA);
    }

    // Con plan propio, Plate Recognizer: cada consulta descuenta de SU plan, encuentre o no una
    // patente. Sin plan, el reconocimiento gratuito si la plataforma lo tiene levantado.
    const playaId = tenantContext.getStore()?.playaId;
    if (!playaId) throw new ForbiddenException('Elegí una playa antes de reconocer una patente.');
    const apiKey = await this.cuentas.tokenDeLaPlaya(playaId);
    if (apiKey) return this.leerConPlateRecognizer(apiKey, file, playaId);

    const alpr = alprConfigurado();
    if (alpr) return this.leerConAlpr(alpr, file);

    throw new ForbiddenException({
      code: 'PATENTES_SIN_PLAN',
      message: 'Esta playa no tiene contratado el reconocimiento de patentes. Escribí la patente a mano.',
    });
  }

  private async leerConPlateRecognizer(
    apiKey: string,
    file: Express.Multer.File,
    playaId: string | undefined,
  ): Promise<PlateRecognitionResult> {
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

    return aResultado(await response.json());
  }

  private async leerConAlpr(
    { url, token }: { url: string; token: string },
    file: Express.Multer.File,
  ): Promise<PlateRecognitionResult> {
    const formData = new FormData();
    formData.append(
      'imagen',
      new Blob([file.buffer], { type: file.mimetype }),
      file.originalname || 'patente.jpg',
    );

    let response: Response;
    try {
      response = await fetch(`${url}/leer`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
        signal: AbortSignal.timeout(ALPR_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error(`No responde el reconocimiento gratuito en ${url}`, error as Error);
      throw new ServiceUnavailableException(ALPR_NO_DISPONIBLE);
    }
    if (response.status === 429) throw new ServiceUnavailableException({
      code: 'ALPR_BUSY', message: 'El reconocimiento de patentes está ocupado. Probá de nuevo en unos segundos.',
    });
    // Un 401 es ALPR_TOKEN distinto en los dos servicios; para el operador es lo mismo que caído.
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(`El reconocimiento gratuito respondió ${response.status}: ${body}`);
      throw new ServiceUnavailableException(ALPR_NO_DISPONIBLE);
    }
    try {
      const data = await response.json();
      if (!data || !Array.isArray(data.results)) throw new Error('Respuesta inválida');
      return aResultado(data);
    } catch {
      this.logger.error('El reconocimiento gratuito devolvió una respuesta inválida.');
      throw new ServiceUnavailableException(ALPR_NO_DISPONIBLE);
    }
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
