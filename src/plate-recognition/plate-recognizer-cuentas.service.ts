import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  cifrarToken,
  descifrarToken,
  hayClaveDeTokens,
} from 'src/mercadopago/token-crypto';
import { alprConfigurado } from './alpr';

const ESTADISTICAS_URL = 'https://api.platerecognizer.com/v1/statistics/';

export type UsoPlateRecognizer = {
  usadas: number;
  total: number;
  restantes: number;
  seRenueva: string | null;
};

export type ConsumoPlaya = {
  playaId: string;
  nombre: string;
  configurado: boolean;
  terminaEn?: string;
  uso?: UsoPlateRecognizer;
  // Otras playas de la empresa con el mismo token: comparten plan y cupo.
  compartidaCon?: string[];
  error?: string;
  // Sin token, la playa escanea con el reconocimiento gratuito (fast-alpr) si está levantado.
  gratuito?: boolean;
};

const mensajeDe = (error: unknown, porDefecto: string): string => {
  const respuesta = (error as { response?: { message?: unknown } })?.response;
  return typeof respuesta?.message === 'string' ? respuesta.message : porDefecto;
};

// La cuenta de Plate Recognizer de cada playa: cada cliente paga su plan y el super admin carga el
// token desde la ficha de la empresa. Ver la migración PlateRecognizerCuentas1790000026000.
@Injectable()
export class PlateRecognizerCuentasService {
  constructor(private readonly dataSource: DataSource) {}

  // Corre en la conexión del operador: la política RLS ya la limita a la fila de su playa.
  async tokenDeLaPlaya(playaId: string): Promise<string | null> {
    const [fila] = await this.dataSource.query(
      'SELECT token FROM plate_recognizer_cuentas WHERE "playaId" = $1',
      [playaId],
    );
    return fila ? descifrarToken(fila.token) : null;
  }

  async configurar(playaId: string, token: string, usuarioId: string | null) {
    if (!hayClaveDeTokens())
      throw new BadRequestException({
        code: 'FALTA_CLAVE_DE_CIFRADO',
        message:
          'Falta configurar MERCADOPAGO_TOKEN_KEY en el servidor: sin esa clave no se pueden guardar tokens.',
      });
    const playa = await this.playa(playaId);
    const limpio = token.trim();
    // Se prueba contra Plate Recognizer antes de guardarlo: un token mal pegado aparece acá y no
    // cuando el operador apunta la cámara a un auto.
    const uso = await this.consultarUso(limpio);
    await this.dataSource.query(
      `INSERT INTO plate_recognizer_cuentas ("playaId", token, huella, "terminaEn", "cargadoPor")
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ("playaId") DO UPDATE SET token = EXCLUDED.token, huella = EXCLUDED.huella,
         "terminaEn" = EXCLUDED."terminaEn", "cargadoPor" = EXCLUDED."cargadoPor", "updatedAt" = now()`,
      [
        playaId,
        cifrarToken(limpio),
        createHash('sha256').update(limpio).digest('hex'),
        limpio.slice(-4),
        usuarioId,
      ],
    );
    return { playa, uso };
  }

  async quitar(playaId: string) {
    const playa = await this.playa(playaId);
    await this.dataSource.query(
      'DELETE FROM plate_recognizer_cuentas WHERE "playaId" = $1',
      [playaId],
    );
    return playa;
  }

  async consumoDeEmpresa(empresaId: string): Promise<ConsumoPlaya[]> {
    const filas: {
      id: string;
      nombre: string;
      token: string | null;
      huella: string | null;
      terminaEn: string | null;
    }[] = await this.dataSource.query(
      `SELECT p.id, p.nombre, c.token, c.huella, c."terminaEn"
       FROM playas p LEFT JOIN plate_recognizer_cuentas c ON c."playaId" = p.id
       WHERE p."empresaId" = $1 ORDER BY p.nombre, p.id`,
      [empresaId],
    );

    // Una consulta por cuenta y no por playa: dos playas con el mismo token comparten el cupo.
    const usos = new Map<string, Promise<UsoPlateRecognizer | { error: string }>>();
    for (const fila of filas) {
      if (!fila.huella || !fila.token || usos.has(fila.huella)) continue;
      const token = fila.token;
      usos.set(
        fila.huella,
        Promise.resolve()
          .then(() => this.consultarUso(descifrarToken(token)))
          .catch((error) => ({
            error: mensajeDe(error, 'No se pudo consultar el consumo.'),
          })),
      );
    }

    return Promise.all(
      filas.map(async (fila): Promise<ConsumoPlaya> => {
        if (!fila.huella)
          return {
            playaId: fila.id,
            nombre: fila.nombre,
            configurado: false,
            gratuito: alprConfigurado() !== null,
          };
        const resultado = await usos.get(fila.huella);
        const compartidaCon = filas
          .filter((otra) => otra.id !== fila.id && otra.huella === fila.huella)
          .map((otra) => otra.nombre);
        const consumo: ConsumoPlaya = {
          playaId: fila.id,
          nombre: fila.nombre,
          configurado: true,
          terminaEn: fila.terminaEn ?? undefined,
        };
        if (resultado) {
          if ('error' in resultado) consumo.error = resultado.error;
          else consumo.uso = resultado;
        }
        if (compartidaCon.length) consumo.compartidaCon = compartidaCon;
        return consumo;
      }),
    );
  }

  // La consulta de estadísticas no gasta reconocimientos del plan.
  async consultarUso(token: string): Promise<UsoPlateRecognizer> {
    let respuesta: Response;
    try {
      respuesta = await fetch(ESTADISTICAS_URL, {
        headers: { Authorization: `Token ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ServiceUnavailableException({
        code: 'PLATE_RECOGNIZER_SIN_CONEXION',
        message: 'No se pudo contactar a Plate Recognizer. Probá de nuevo en un rato.',
      });
    }
    if (respuesta.status === 401 || respuesta.status === 403)
      throw new BadRequestException({
        code: 'PLATE_RECOGNIZER_TOKEN_INVALIDO',
        message:
          'Plate Recognizer no acepta ese token. Copialo de nuevo desde la cuenta del cliente (API Token).',
      });
    if (!respuesta.ok)
      throw new ServiceUnavailableException({
        code: 'PLATE_RECOGNIZER_SIN_CONEXION',
        message: `Plate Recognizer respondió ${respuesta.status}. Probá de nuevo en un rato.`,
      });

    const datos = await respuesta.json();
    const total = Number(datos?.total_calls) || 0;
    const usadas = Number(datos?.usage?.calls) || 0;
    return {
      usadas,
      total,
      restantes: Math.max(0, total - usadas),
      seRenueva: typeof datos?.usage?.resets_on === 'string' ? datos.usage.resets_on : null,
    };
  }

  private async playa(playaId: string): Promise<{ id: string; nombre: string; empresaId: string }> {
    const [playa] = await this.dataSource.query(
      'SELECT id, nombre, "empresaId" FROM playas WHERE id = $1',
      [playaId],
    );
    if (!playa) throw new NotFoundException('Playa no encontrada.');
    return playa;
  }
}
