import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { tenantContext } from 'src/tenancy/tenant-context';
import { VehicleTypeEntity } from 'src/tickets/entities/vehicle-type.entity';
import { modelosGemini, requestGemini } from 'src/assistant/gemini-request';
import { FOTO_PESADA, PLATE_IMAGE_MAX_BYTES } from './plate-recognition.service';

export type VehiculoDetectado = {
  // El tipo sugerido, siempre uno habilitado de la playa; null si no se pudo saber.
  vehicleType: string | null;
  // Marca y modelo como se los conoce en Argentina («Fiat Strada»); null si no se pudo saber.
  modelo: string | null;
};

const NINGUNO = 'NINGUNO';
// Gemini tarda entre uno y tres segundos. Más que esto ya no ayuda: el operador eligió a mano.
const GEMINI_PLAZO_MS = 10_000;
const NADA: VehiculoDetectado = { vehicleType: null, modelo: null };

/**
 * Sugiere el tipo y el modelo del vehículo a partir de la foto con la que se leyó la patente. La
 * patente la lee siempre el motor de patentes de la playa (Plate Recognizer o el gratuito); esto
 * solo agrega el vehículo, con Gemini. Es una sugerencia: el operador la ve elegida y la puede
 * cambiar, y si Gemini no responde se elige a mano como siempre.
 *
 * La foto se manda a Google solo para esta consulta (como las preguntas del asistente) y no se
 * guarda en ningún lado.
 */
@Injectable()
export class TipoVehiculoService {
  private readonly logger = new Logger(TipoVehiculoService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async detectar(file: Express.Multer.File): Promise<VehiculoDetectado> {
    if (file.size > PLATE_IMAGE_MAX_BYTES) throw new BadRequestException(FOTO_PESADA);
    const scope = tenantContext.getStore();
    if (!scope?.playaId) throw new ForbiddenException('Elegí una playa antes de detectar el vehículo.');

    const key = this.config.get<string>('GEMINI_API_KEY');
    if (!key) return NADA;
    const models = modelosGemini(this.config);
    if (models.some((model) => !/^[a-zA-Z0-9.-]+$/.test(model))) return NADA;
    // Como el resto de los tipos, los de la playa los recorta la RLS de la conexión.
    const tipos = await this.dataSource.getRepository(VehicleTypeEntity).find({ where: { enabled: true }, order: { code: 'ASC' } });
    if (!tipos.length) return NADA;

    const codigos = tipos.map((t) => t.code);
    const lista = tipos.map((t) => `- ${t.code}: ${t.name.replace(/\s+/g, ' ').slice(0, 80)}`).join('\n');
    const pedido = [
      'Foto sacada con el celular por el operador de un estacionamiento en Argentina, apuntando a la patente de un vehículo.',
      'Decí de qué tipo es el vehículo de esa patente (el del centro de la foto), eligiendo uno de los tipos de esta playa:',
      lista,
      'Una pickup, una SUV, un utilitario o un furgón es una camioneta si la playa tiene ese tipo; si no, el tipo más parecido.',
      `Si no se ve ningún vehículo o no se puede saber, respondé ${NINGUNO}.`,
      'En «modelo» poné la marca y el modelo comercial como se los conoce en Argentina, sin versión, motor ni año (por ejemplo «Fiat Strada», «Volkswagen Gol Trend», «Honda Wave 110»). Si no estás seguro, dejalo vacío.',
    ].join('\n');
    const body = (model: string) => ({
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: file.mimetype, data: file.buffer.toString('base64') } },
          { text: pedido },
        ],
      }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 200,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: { tipo: { type: 'STRING', enum: [...codigos, NINGUNO] }, modelo: { type: 'STRING' } },
          required: ['tipo', 'modelo'],
        },
        ...(model.startsWith('gemini-3') ? { thinkingConfig: { thinkingLevel: model.includes('flash-lite') ? 'MINIMAL' : 'LOW' } } : {}),
      },
    });
    try {
      const { parts } = await requestGemini(key, models, body, Date.now() + GEMINI_PLAZO_MS, (message) => this.logger.warn(message));
      const texto = parts.find((p) => typeof p.text === 'string' && !p.thought)?.text ?? '';
      const respuesta = JSON.parse(texto);
      const vehicleType = typeof respuesta?.tipo === 'string' && codigos.includes(respuesta.tipo) ? respuesta.tipo : null;
      // Texto libre del modelo: solo letras, números y signos de un nombre, con el tope de la columna.
      const modelo = typeof respuesta?.modelo === 'string'
        ? respuesta.modelo.replace(/[^\p{L}\p{N} .+\-!/]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60)
        : '';
      return { vehicleType, modelo: modelo || null };
    } catch (error) {
      // Cuota, clave o respuesta inválida: el vehículo se elige a mano, como siempre.
      this.logger.warn(`Gemini no detectó el vehículo: ${(error as Error)?.message ?? 'error'}`);
      return NADA;
    }
  }
}
