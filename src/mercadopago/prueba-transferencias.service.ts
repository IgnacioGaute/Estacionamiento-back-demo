import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CuentaMercadoPago } from './entities/cuenta-mercadopago.entity';
import { MercadoPagoService } from './mercadopago.service';
import { CONDICIONES_VIGENTES } from './condiciones';
import { tenantContext } from '../tenancy/tenant-context';

// PRUEBA, no función comercial. Sirve para averiguar con evidencia si las transferencias que
// recibe una cuenta conectada por OAuth (desde un banco o desde otra cuenta de MercadoPago) se
// pueden ver desde el sistema, con qué datos y con qué demora, antes de construir la verificación
// de transferencias. Ver docs/verificacion-transferencias.md.
//
// Reglas de la prueba (las mismas que prometen las condiciones de condiciones.ts):
// - La usa la empresa dueña de la cuenta, sobre su propia cuenta: un administrador de la empresa,
//   en el alcance de su sesión. El SUPER_ADMIN no: la plataforma no ve los pagos de los clientes.
// - Solo con las condiciones vigentes aceptadas (al conectar la cuenta o después). Sin eso
//   contesta 403 sin llegar a pedir el token.
// - Solo muestra plata que ENTRÓ a la cuenta. Lo que la cuenta pagó (compras, suscripciones) se
//   cuenta pero no se muestra.
// - No guarda nada, no toca cobros, caja ni movimientos, y no loguea datos de pagos.
// - Lo único que escribe en MercadoPago es pedir un reporte (y crear la configuración del reporte
//   si la cuenta no tenía ninguna; una existente no se modifica nunca).

const API = 'https://api.mercadopago.com';
const TIEMPO_LIMITE_MS = 15_000;

// Ventanas de búsqueda permitidas, en minutos. Cinco es la inicial; las más largas existen para
// medir demoras y no descartar transferencias que MercadoPago informa tarde.
export const VENTANAS_PRUEBA = [5, 30, 120, 1440] as const;
export type VentanaPrueba = (typeof VENTANAS_PRUEBA)[number];

// Las columnas del reporte «Todas las transacciones» que sirven para reconocer una transferencia
// y asociarla a un cobro. Son nombres de la documentación oficial (report-fields). Los datos del
// que pagó, según MercadoPago, «solo se podrán usar para conciliar».
export const COLUMNAS_REPORTE = [
  'SOURCE_ID',
  'EXTERNAL_REFERENCE',
  'TRANSACTION_TYPE',
  'TRANSACTION_AMOUNT',
  'TRANSACTION_CURRENCY',
  'TRANSACTION_DATE',
  'SETTLEMENT_DATE',
  'PAYMENT_METHOD_TYPE',
  'PAYMENT_METHOD',
  'DESCRIPTION',
  'PAYER_NAME',
  'PAYER_ID_TYPE',
  'PAYER_ID_NUMBER',
  'PAY_BANK_TRANSFER_ID',
  'POI_BANK_NAME',
  'POI_WALLET_NAME',
  'BUSINESS_UNIT',
  'SUB_UNIT',
  'OPERATION_TAGS',
] as const;

type Consulta =
  | { ok: true; estado: number; datos: any; texto: string }
  | { ok: false; estado: number | null; error: string };

// Solo los campos simples de un objeto de MercadoPago, para mostrar respuestas cuya forma no se
// conoce de antemano sin arrastrar estructuras enteras.
export function primitivos(
  objeto: unknown,
): Record<string, string | number | boolean | null> {
  if (!objeto || typeof objeto !== 'object') return {};
  return Object.fromEntries(
    Object.entries(objeto)
      .filter(
        ([, v]) =>
          v === null || ['string', 'number', 'boolean'].includes(typeof v),
      )
      .slice(0, 30),
  ) as Record<string, string | number | boolean | null>;
}

/**
 * Un CSV de MercadoPago a filas. Respeta comillas (un nombre puede traer comas) y detecta el
 * separador mirando el encabezado, porque es configurable por cuenta.
 */
export function leerCsv(texto: string): {
  columnas: string[];
  filas: Record<string, string>[];
} {
  const limpio = texto.replace(/^﻿/, '');
  const primeraLinea = limpio.split(/\r?\n/, 1)[0] ?? '';
  const separador =
    (primeraLinea.match(/;/g)?.length ?? 0) >
    (primeraLinea.match(/,/g)?.length ?? 0)
      ? ';'
      : ',';
  const registros: string[][] = [];
  let registro: string[] = [];
  let campo = '';
  let entreComillas = false;
  for (let i = 0; i < limpio.length; i++) {
    const c = limpio[i];
    if (entreComillas) {
      if (c === '"' && limpio[i + 1] === '"') {
        campo += '"';
        i++;
      } else if (c === '"') entreComillas = false;
      else campo += c;
    } else if (c === '"') entreComillas = true;
    else if (c === separador) {
      registro.push(campo);
      campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && limpio[i + 1] === '\n') i++;
      registro.push(campo);
      registros.push(registro);
      registro = [];
      campo = '';
    } else campo += c;
  }
  if (campo || registro.length) {
    registro.push(campo);
    registros.push(registro);
  }
  const [encabezado = [], ...resto] = registros.filter(
    (r) => r.length > 1 || r[0] !== '',
  );
  const columnas = encabezado.map((c) => c.trim());
  const filas = resto.map((r) =>
    Object.fromEntries(columnas.map((c, i) => [c, (r[i] ?? '').trim()])),
  );
  return { columnas, filas };
}

/**
 * Las filas del reporte que son plata que entró: operaciones aprobadas (SETTLEMENT) con importe
 * positivo. De cada una quedan solo las columnas de COLUMNAS_REPORTE. Si el reporte no trae
 * TRANSACTION_TYPE y TRANSACTION_AMOUNT con esos nombres no se puede separar lo que entró de lo
 * que salió, y entonces no se devuelve ninguna fila.
 */
export function ingresosDelReporte(csv: string) {
  const { columnas, filas } = leerCsv(csv);
  const reconocible =
    columnas.includes('TRANSACTION_TYPE') &&
    columnas.includes('TRANSACTION_AMOUNT');
  if (!reconocible)
    return { columnas, reconocible, totalFilas: filas.length, ingresos: [] };
  const ingresos = filas
    .filter(
      (f) =>
        f.TRANSACTION_TYPE === 'SETTLEMENT' &&
        Number(f.TRANSACTION_AMOUNT.replace(',', '.')) > 0,
    )
    .slice(0, 100)
    .map((f) =>
      Object.fromEntries(
        COLUMNAS_REPORTE.filter((c) => c in f).map((c) => [c, f[c]]),
      ),
    );
  return { columnas, reconocible, totalFilas: filas.length, ingresos };
}

@Injectable()
export class PruebaTransferenciasService {
  constructor(
    @InjectRepository(CuentaMercadoPago)
    private readonly cuentas: Repository<CuentaMercadoPago>,
    private readonly mercadoPago: MercadoPagoService,
  ) {}

  /**
   * La cuenta conectada de la empresa de la sesión, solo para su administrador y solo con las
   * condiciones vigentes aceptadas. Todo se chequea antes de descifrar el token.
   */
  private async cuentaDePrueba() {
    const scope = tenantContext.getStore();
    // El TenantGuard ya deja afuera al operador (este controlador no está en OPERATOR_ENDPOINTS);
    // acá se excluye además al SUPER_ADMIN, que el guard sí deja pasar a cualquier empresa.
    if (!scope?.empresaId || scope.platform || scope.role !== 'ADMIN')
      throw new ForbiddenException({
        code: 'SOLO_LA_EMPRESA',
        message:
          'Los pagos de una cuenta de MercadoPago los consulta solo un administrador de la empresa dueña.',
      });
    const cuenta = await this.cuentas.findOneBy({ empresaId: scope.empresaId });
    if (!cuenta || cuenta.estado === 'DESCONECTADA' || !cuenta.accessToken)
      throw new BadRequestException(
        'La empresa no tiene MercadoPago conectado.',
      );
    if (cuenta.condicionesVersion !== CONDICIONES_VIGENTES.version)
      throw new ForbiddenException({
        code: 'CONDICIONES_SIN_ACEPTAR',
        message:
          'Para consultar los pagos que entran a la cuenta, un administrador tiene que aceptar las condiciones de uso de MercadoPago.',
      });
    const token = await this.mercadoPago.tokenDeEmpresa(scope.empresaId);
    return { cuenta, token };
  }

  private ventana(minutos: VentanaPrueba) {
    const hasta = new Date();
    const desde = new Date(hasta.getTime() - minutos * 60 * 1000);
    return { desde, hasta };
  }

  /**
   * Los pagos que MercadoPago informa en `/v1/payments/search` para la ventana pedida, solo los
   * que entraron a la cuenta. La búsqueda trae también lo que la cuenta pagó; eso se cuenta en
   * `egresosOmitidos` y no se muestra.
   */
  async ingresos(minutos: VentanaPrueba) {
    const { cuenta, token } = await this.cuentaDePrueba();
    const { desde, hasta } = this.ventana(minutos);
    const busqueda = new URLSearchParams({
      sort: 'date_created',
      criteria: 'desc',
      range: 'date_created',
      begin_date: desde.toISOString(),
      end_date: hasta.toISOString(),
      limit: '100',
    });
    const r = await this.consultar(
      `${API}/v1/payments/search?${busqueda}`,
      token,
    );
    const base = {
      cuenta: { mpUserId: cuenta.mpUserId, nickname: cuenta.nickname },
      minutos,
      desde: desde.toISOString(),
      hasta: hasta.toISOString(),
      consultadoEl: new Date().toISOString(),
    };
    if (r.ok === false) return { ...base, pagos: r };
    const resultados = (r.datos?.results ?? []) as any[];
    const items = resultados.map((p) => this.pago(p, cuenta.mpUserId));
    const entrantes = items.filter((p) => p.recibido !== false);
    return {
      ...base,
      pagos: {
        ok: true as const,
        total: r.datos?.paging?.total ?? null,
        // La búsqueda trae como mucho 100: si hay más, la ventana es demasiado larga.
        truncado: (r.datos?.paging?.total ?? 0) > resultados.length,
        egresosOmitidos: items.length - entrantes.length,
        items: entrantes,
      },
    };
  }

  // Lo que sirve para reconocer de dónde vino la plata y medir la demora.
  private pago(p: any, mpUserId: string) {
    const bancos = p.point_of_interaction?.transaction_data?.bank_info;
    return {
      id: p.id,
      creado: p.date_created ?? null,
      aprobado: p.date_approved ?? null,
      actualizado: p.date_last_updated ?? null,
      estado: p.status ?? null,
      detalle: p.status_detail ?? null,
      importe: p.transaction_amount ?? null,
      moneda: p.currency_id ?? null,
      neto: p.transaction_details?.net_received_amount ?? null,
      operacion: p.operation_type ?? null,
      tipo: p.payment_type_id ?? null,
      medio: p.payment_method_id ?? null,
      descripcion: p.description ?? null,
      referencia: p.external_reference ?? null,
      // Sin `collector_id` no se sabe si entró o salió, y se dice así en vez de suponer.
      cobradorId: p.collector_id ?? null,
      recibido:
        p.collector_id != null
          ? String(p.collector_id) === String(mpUserId)
          : null,
      pagador: {
        nombre:
          [p.payer?.first_name, p.payer?.last_name].filter(Boolean).join(' ') ||
          null,
        documento: p.payer?.identification?.number
          ? `${p.payer.identification.type ?? ''} ${p.payer.identification.number}`.trim()
          : null,
      },
      origen: p.point_of_interaction
        ? {
            tipo: p.point_of_interaction.type ?? null,
            subtipo: p.point_of_interaction.sub_type ?? null,
            banco: bancos
              ? {
                  pagador: primitivos(bancos.payer),
                  cobrador: primitivos(bancos.collector),
                }
              : null,
          }
        : null,
      claves: Object.keys(p ?? {}),
    };
  }

  /**
   * Estado del reporte «Todas las transacciones» de la cuenta: su configuración (si tiene) y los
   * últimos reportes generados. Solo lectura.
   */
  async reporte() {
    const { token } = await this.cuentaDePrueba();
    const [config, lista] = await Promise.all([
      this.consultar(`${API}/v1/account/settlement_report/config`, token),
      this.consultar(`${API}/v1/account/settlement_report/list`, token),
    ]);
    return {
      config:
        config.ok === true
          ? {
              ok: true as const,
              ...primitivos(config.datos),
              columnas: ((config.datos?.columns ?? []) as any[]).map(
                (c) => c?.key,
              ),
              faltan: COLUMNAS_REPORTE.filter(
                (c) =>
                  !((config.datos?.columns ?? []) as any[]).some(
                    (x) => x?.key === c,
                  ),
              ),
            }
          : config,
      reportes:
        lista.ok === true
          ? {
              ok: true as const,
              items: ((Array.isArray(lista.datos) ? lista.datos : []) as any[])
                .slice(0, 20)
                .map(primitivos),
            }
          : lista,
    };
  }

  /**
   * Crea la configuración del reporte con las columnas de COLUMNAS_REPORTE, solo si la cuenta no
   * tiene ninguna. Una configuración existente es del dueño de la cuenta y no se toca.
   */
  async configurarReporte() {
    const { token } = await this.cuentaDePrueba();
    const actual = await this.consultar(
      `${API}/v1/account/settlement_report/config`,
      token,
    );
    if (actual.ok)
      throw new BadRequestException(
        'La cuenta ya tiene una configuración del reporte y no se modifica. Si le faltan columnas, se agregan desde MercadoPago.',
      );
    if (actual.estado !== 404) return { creada: false, respuesta: actual };
    const r = await this.consultar(
      `${API}/v1/account/settlement_report/config`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          file_name_prefix: 'conciliacion-transferencias',
          columns: COLUMNAS_REPORTE.map((key) => ({ key })),
          frequency: { hour: 0, type: 'monthly', value: 1 },
          display_timezone: 'GMT-03',
          header_language: 'en',
        }),
      },
    );
    return {
      creada: r.ok,
      respuesta: r.ok === true ? { ok: true as const, estado: r.estado } : r,
    };
  }

  /**
   * Pide a MercadoPago un reporte de la ventana. Es asíncrono (202): para medir la demora se
   * devuelve cuándo se pidió, y el reporte aparece después en la lista.
   */
  async pedirReporte(minutos: VentanaPrueba) {
    const { token } = await this.cuentaDePrueba();
    const { desde, hasta } = this.ventana(minutos);
    const r = await this.consultar(
      `${API}/v1/account/settlement_report`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          begin_date: desde.toISOString(),
          end_date: hasta.toISOString(),
        }),
      },
    );
    return {
      pedidoEl: new Date().toISOString(),
      desde: desde.toISOString(),
      hasta: hasta.toISOString(),
      respuesta:
        r.ok === true
          ? { ok: true as const, estado: r.estado, ...primitivos(r.datos) }
          : r,
    };
  }

  /** Descarga un reporte y devuelve solo las filas de plata que entró, con columnas acotadas. */
  async leerReporte(archivo: string) {
    if (!/^[\w.-]{1,200}$/.test(archivo))
      throw new BadRequestException('Nombre de reporte inválido.');
    const { token } = await this.cuentaDePrueba();
    const r = await this.consultar(
      `${API}/v1/account/settlement_report/${encodeURIComponent(archivo)}`,
      token,
    );
    if (r.ok === false) return { archivo, respuesta: r };
    return {
      archivo,
      leidoEl: new Date().toISOString(),
      respuesta: { ok: true as const, ...ingresosDelReporte(r.texto) },
    };
  }

  // Devuelve también lo que MercadoPago contestó cuando falla, porque eso es parte de lo que se
  // prueba. De un error solo sale el mensaje de MercadoPago, recortado; nada se loguea.
  private async consultar(
    url: string,
    token: string,
    init: RequestInit = {},
  ): Promise<Consulta> {
    try {
      const respuesta = await fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
      });
      const texto = await respuesta.text().catch(() => '');
      let datos: any = null;
      try {
        datos = texto ? JSON.parse(texto) : null;
      } catch {
        datos = null;
      }
      if (respuesta.ok)
        return { ok: true, estado: respuesta.status, datos, texto };
      const mensaje = [datos?.error, datos?.message].filter(Boolean).join(': ');
      return {
        ok: false,
        estado: respuesta.status,
        error: String(mensaje || 'Sin detalle').slice(0, 200),
      };
    } catch (error) {
      return {
        ok: false,
        estado: null,
        error:
          error instanceof Error
            ? error.message
            : 'No se pudo contactar a MercadoPago.',
      };
    }
  }
}
