import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ZONA } from './estado-cuenta';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

const API = 'https://api.mercadopago.com';
const TIEMPO_LIMITE_MS = 12_000;

export type PagoMp = {
  id: string;
  estado: string;
  monto: number;
  // Día (Argentina) en que se aprobó.
  fecha: string;
  referencia: string | null;
};

export type SuscripcionMp = {
  id: string;
  estado: 'pending' | 'authorized' | 'paused' | 'cancelled';
  referencia: string | null;
  importe: number;
  url: string | null;
};

export type CobroDeSuscripcionMp = {
  id: string;
  suscripcionId: string;
  pago: PagoMp | null;
};

const diaAR = (iso: string | null | undefined) =>
  dayjs(iso ?? undefined)
    .tz(ZONA)
    .format('YYYY-MM-DD');

// El MercadoPago de la PLATAFORMA: la cuenta donde entra lo que pagan las empresas por el sistema.
// Es otra aplicación y otro token que los de `src/mercadopago`, que cobran en nombre de cada
// empresa: nada de acá usa esas credenciales ni al revés.
//
// La tarjeta del débito automático la carga el cliente en MercadoPago; acá nunca pasan datos de
// tarjeta. Y nada de lo que llega en un aviso se cree: los avisos solo disparan una consulta a la
// API con el token propio, que es lo que vale.
@Injectable()
export class MercadoPagoPlataforma {
  private readonly logger = new Logger(MercadoPagoPlataforma.name);

  constructor(private readonly config: ConfigService) {}

  configurado() {
    return !!this.config.get<string>('MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN');
  }

  /**
   * La clave pública de la aplicación: el formulario de tarjeta de MercadoPago la necesita en el
   * navegador para convertir la tarjeta en un token. Es pública por diseño (no autoriza cobros).
   */
  clavePublica() {
    if (!this.configurado()) return null;
    return this.config.get<string>('MERCADOPAGO_PLATAFORMA_PUBLIC_KEY') || null;
  }

  /** A dónde vuelve el cliente después de pagar: la pantalla de pago del panel. */
  urlDeVuelta(motivo: 'pago' | 'debito') {
    const explicita = this.config.get<string>('PLATAFORMA_URL_FRONT');
    const oauth = this.config.get<string>('MERCADOPAGO_REDIRECT_URI');
    const permitidos = (this.config.get<string>('ALLOWED_ORIGINS') ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    let origen = explicita ?? '';
    if (!origen && oauth) {
      try {
        origen = new URL(oauth).origin;
      } catch {
        origen = '';
      }
    }
    origen = (origen || permitidos[0] || '').replace(/\/$/, '');
    return `${origen}/admin/plan/pagar?mp=${motivo}`;
  }

  /** Un pago único por el importe indicado. Devuelve la url de MercadoPago donde se paga. */
  async crearPago(datos: {
    referencia: string;
    titulo: string;
    importe: number;
    vence: Date;
  }) {
    const aviso = this.config.get<string>('MERCADOPAGO_PLATAFORMA_WEBHOOK_URL');
    const vuelta = this.urlDeVuelta('pago');
    const respuesta = await this.llamar(`${API}/checkout/preferences`, {
      method: 'POST',
      body: {
        items: [
          {
            title: datos.titulo,
            quantity: 1,
            currency_id: 'ARS',
            unit_price: datos.importe,
          },
        ],
        external_reference: datos.referencia,
        expires: true,
        expiration_date_to: datos.vence.toISOString(),
        back_urls: { success: vuelta, pending: vuelta, failure: vuelta },
        auto_return: vuelta.startsWith('https://') ? 'approved' : undefined,
        // MercadoPago solo acepta avisos a una dirección pública con https.
        notification_url: aviso?.startsWith('https://') ? aviso : undefined,
      },
    });
    const url = respuesta.init_point ?? respuesta.sandbox_init_point;
    if (!respuesta.id || !url)
      throw new ServiceUnavailableException(
        'MercadoPago no devolvió el link de pago. Probá de nuevo en un momento.',
      );
    return { id: String(respuesta.id), url: String(url) };
  }

  /** Los pagos hechos con una referencia nuestra. */
  async pagosConReferencia(referencia: string): Promise<PagoMp[]> {
    const url = new URL(`${API}/v1/payments/search`);
    url.searchParams.set('external_reference', referencia);
    url.searchParams.set('sort', 'date_created');
    url.searchParams.set('criteria', 'desc');
    const datos = await this.llamar(url.toString());
    return ((datos.results ?? []) as any[]).map(aPago);
  }

  async pago(id: string): Promise<PagoMp> {
    return aPago(
      await this.llamar(`${API}/v1/payments/${encodeURIComponent(id)}`),
    );
  }

  /**
   * El débito automático: una suscripción de MercadoPago que cobra cada `meses` meses (uno, tres
   * o doce, según el período de pago de la empresa). Dos formas:
   *
   * - Con `tarjeta` (el token del formulario de tarjeta de MercadoPago en nuestra pantalla): queda
   *   autorizada en el acto y no hace falta cuenta de MercadoPago. MercadoPago valida la tarjeta con
   *   un cobro mínimo que devuelve.
   * - Sin tarjeta: queda «pendiente» y el cliente la confirma en MercadoPago, entrando con su cuenta.
   *
   * `inicio` es el día del primer cobro (null: en el momento).
   */
  async crearSuscripcion(datos: {
    referencia: string;
    motivo: string;
    email: string;
    importe: number;
    meses?: number;
    inicio: string | null;
    tarjeta?: string;
  }): Promise<SuscripcionMp> {
    const respuesta = await this.llamar(
      `${API}/preapproval`,
      {
        method: 'POST',
        body: {
          reason: datos.motivo,
          external_reference: datos.referencia,
          payer_email: datos.email,
          back_url: this.urlDeVuelta('debito'),
          ...(datos.tarjeta
            ? { card_token_id: datos.tarjeta, status: 'authorized' }
            : { status: 'pending' }),
          auto_recurring: {
            frequency: datos.meses ?? 1,
            frequency_type: 'months',
            transaction_amount: datos.importe,
            currency_id: 'ARS',
            // A las 9 de la mañana del día del vencimiento, hora de Argentina.
            ...(datos.inicio
              ? {
                  start_date: dayjs
                    .tz(`${datos.inicio} 09:00`, ZONA)
                    .toISOString(),
                }
              : {}),
          },
        },
      },
      datos.tarjeta
        ? 'MercadoPago no aceptó la tarjeta. Revisá los datos o probá con otra.'
        : undefined,
    );
    return aSuscripcion(respuesta);
  }

  async suscripcion(id: string): Promise<SuscripcionMp> {
    return aSuscripcion(
      await this.llamar(`${API}/preapproval/${encodeURIComponent(id)}`),
    );
  }

  async actualizarSuscripcion(
    id: string,
    cambios: {
      importe?: number;
      estado?: 'cancelled' | 'paused' | 'authorized';
    },
  ) {
    await this.llamar(`${API}/preapproval/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: {
        ...(cambios.estado ? { status: cambios.estado } : {}),
        ...(cambios.importe !== undefined
          ? {
              auto_recurring: {
                transaction_amount: cambios.importe,
                currency_id: 'ARS',
              },
            }
          : {}),
      },
    });
  }

  /** Los cobros mensuales de un débito automático, con el pago de cada uno. */
  async cobrosDeSuscripcion(id: string): Promise<CobroDeSuscripcionMp[]> {
    const url = new URL(`${API}/authorized_payments/search`);
    url.searchParams.set('preapproval_id', id);
    const datos = await this.llamar(url.toString());
    return ((datos.results ?? []) as any[]).map(aCobro);
  }

  async cobroDeSuscripcion(id: string): Promise<CobroDeSuscripcionMp> {
    return aCobro(
      await this.llamar(`${API}/authorized_payments/${encodeURIComponent(id)}`),
    );
  }

  /**
   * La firma de un aviso: HMAC-SHA256 de «id:<data.id>;request-id:<x-request-id>;ts:<ts>;» con la
   * clave secreta del webhook de la aplicación. Sin clave configurada no se puede validar: el aviso
   * igual solo dispara una consulta con el token propio, así que no se le cree nada.
   */
  firmaValida(datos: {
    firma: string | undefined;
    requestId: string | undefined;
    dataId: string;
  }) {
    const secreto = this.config.get<string>(
      'MERCADOPAGO_PLATAFORMA_WEBHOOK_SECRET',
    );
    if (!secreto) return true;
    const partes = Object.fromEntries(
      (datos.firma ?? '')
        .split(',')
        .map((p) => p.trim().split('=') as [string, string]),
    );
    if (!partes.ts || !partes.v1) return false;
    const id = /^[a-z0-9]+$/i.test(datos.dataId)
      ? datos.dataId.toLowerCase()
      : datos.dataId;
    const manifiesto = `id:${id};request-id:${datos.requestId ?? ''};ts:${partes.ts};`;
    const esperada = createHmac('sha256', secreto)
      .update(manifiesto)
      .digest('hex');
    const a = Buffer.from(esperada);
    const b = Buffer.from(partes.v1);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // `rechazo`: qué decirle al cliente si MercadoPago no acepta el pedido (4xx).
  private async llamar(
    url: string,
    init: { method?: string; body?: unknown } = {},
    rechazo = 'MercadoPago no aceptó la operación. Revisá el email de tu cuenta de MercadoPago y probá de nuevo.',
  ): Promise<any> {
    const token = this.config.get<string>(
      'MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN',
    );
    if (!token)
      throw new ServiceUnavailableException(
        'Los pagos con MercadoPago todavía no están configurados.',
      );
    let respuesta: Response;
    try {
      respuesta = await fetch(url, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
      });
    } catch (error) {
      this.logger.error(
        `No se pudo contactar a MercadoPago: ${error instanceof Error ? error.message : error}`,
      );
      throw new ServiceUnavailableException(
        'No pudimos comunicarnos con MercadoPago. Probá de nuevo en un momento.',
      );
    }
    if (!respuesta.ok) {
      // El mensaje de MercadoPago se loguea (no trae credenciales) pero no se reenvía tal cual:
      // está en inglés y habla de su API.
      const detalle = await respuesta.text().catch(() => '');
      this.logger.error(
        `MercadoPago respondió ${respuesta.status} a ${init.method ?? 'GET'} ${new URL(url).pathname}: ${detalle.slice(0, 300)}`,
      );
      if (respuesta.status >= 400 && respuesta.status < 500)
        throw new BadRequestException(rechazo);
      throw new ServiceUnavailableException(
        'MercadoPago no está respondiendo. Probá de nuevo en un momento.',
      );
    }
    return respuesta.json();
  }
}

function aPago(p: any): PagoMp {
  return {
    id: String(p?.id ?? ''),
    estado: String(p?.status ?? ''),
    monto: Math.round(Number(p?.transaction_amount) || 0),
    fecha: diaAR(p?.date_approved ?? p?.date_created),
    referencia: p?.external_reference ? String(p.external_reference) : null,
  };
}

function aSuscripcion(s: any): SuscripcionMp {
  return {
    id: String(s?.id ?? ''),
    estado: (['pending', 'authorized', 'paused', 'cancelled'].includes(
      s?.status,
    )
      ? s.status
      : 'pending') as SuscripcionMp['estado'],
    referencia: s?.external_reference ? String(s.external_reference) : null,
    importe: Math.round(Number(s?.auto_recurring?.transaction_amount) || 0),
    url: s?.init_point ? String(s.init_point) : null,
  };
}

function aCobro(c: any): CobroDeSuscripcionMp {
  const pago = c?.payment?.id
    ? {
        id: String(c.payment.id),
        estado: String(c.payment.status ?? ''),
        monto: Math.round(Number(c?.transaction_amount) || 0),
        fecha: diaAR(c?.last_modified ?? c?.date_created),
        referencia: null,
      }
    : null;
  return {
    id: String(c?.id ?? ''),
    suscripcionId: String(c?.preapproval_id ?? ''),
    pago,
  };
}
