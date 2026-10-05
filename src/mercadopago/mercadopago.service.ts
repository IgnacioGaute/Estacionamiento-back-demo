import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CuentaMercadoPago } from './entities/cuenta-mercadopago.entity';
import { cifrarToken, descifrarToken, hayClaveDeTokens } from './token-crypto';
import { consumirState, crearState } from './oauth-state';
import { tenantContext } from '../tenancy/tenant-context';

const AUTORIZACION = 'https://auth.mercadopago.com.ar/authorization';
const API = 'https://api.mercadopago.com';
const TIEMPO_LIMITE_MS = 12_000;
// MercadoPago da tokens de 180 días; si alguna vez no informa el vencimiento, se asume ese plazo.
const VIGENCIA_POR_DEFECTO = 15_552_000;

interface RespuestaToken {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user_id: number | string;
}

// Conexión de la cuenta de MercadoPago de cada empresa (OAuth). El admin sale al sitio de
// MercadoPago, autoriza con su cuenta, y acá se canjea el código por los tokens.
//
// El Client Secret no sale nunca de este servicio y los tokens no salen nunca del backend: hacia
// el panel viaja únicamente qué cuenta quedó conectada y desde cuándo.
@Injectable()
export class MercadoPagoService {
  private readonly logger = new Logger(MercadoPagoService.name);

  constructor(
    @InjectRepository(CuentaMercadoPago)
    private readonly cuentas: Repository<CuentaMercadoPago>,
    private readonly config: ConfigService,
  ) {}

  private empresaActual(): string {
    const scope = tenantContext.getStore();
    // El SUPER_ADMIN no tiene empresa: la cuenta que cobra es la de un cliente, no la de la plataforma.
    if (!scope?.empresaId)
      throw new BadRequestException(
        'Esta acción es de una empresa: entrá como administrador de la empresa que va a cobrar.',
      );
    return scope.empresaId;
  }

  private ajustes() {
    const clientId = this.config.get<string>('MERCADOPAGO_CLIENT_ID');
    const clientSecret = this.config.get<string>('MERCADOPAGO_CLIENT_SECRET');
    const redirectUri = this.config.get<string>('MERCADOPAGO_REDIRECT_URI');
    if (!clientId || !clientSecret || !redirectUri || !hayClaveDeTokens()) {
      this.logger.error(
        'Falta configurar MERCADOPAGO_CLIENT_ID, MERCADOPAGO_CLIENT_SECRET, MERCADOPAGO_REDIRECT_URI o MERCADOPAGO_TOKEN_KEY.',
      );
      throw new ServiceUnavailableException(
        'El cobro con MercadoPago todavía no está configurado en el servidor.',
      );
    }
    return { clientId, clientSecret, redirectUri };
  }

  /** La URL a la que hay que mandar el navegador del admin para que autorice. */
  iniciarConexion(usuarioId: string) {
    const { clientId, redirectUri } = this.ajustes();
    const empresaId = this.empresaActual();
    const state = crearState(empresaId, usuarioId);
    const url = new URL(AUTORIZACION);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('platform_id', 'mp');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return { url: url.toString() };
  }

  /**
   * Canje del código por los tokens. Lo llama el panel del admin, ya autenticado: además del
   * `state` se exige que la empresa y el usuario coincidan con los de la sesión, así un código
   * interceptado por sí solo no alcanza para conectar una cuenta.
   */
  async conectar(code: string, state: string, usuarioId: string) {
    const { clientId, clientSecret, redirectUri } = this.ajustes();
    const empresaId = this.empresaActual();

    const pendiente = consumirState(state);
    if (!pendiente)
      throw new UnauthorizedException(
        'La conexión venció o ya se usó. Empezá de nuevo desde el botón de conectar.',
      );
    if (pendiente.empresaId !== empresaId || pendiente.usuarioId !== usuarioId)
      throw new UnauthorizedException(
        'Esta autorización se inició desde otra cuenta. Empezá de nuevo desde el botón de conectar.',
      );

    const token = await this.pedirToken({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });

    const datos = await this.datosDeCuenta(token.access_token);
    const existente = await this.cuentas.findOneBy({ empresaId });
    const fila = this.cuentas.create({
      ...(existente ?? {}),
      empresaId,
      mpUserId: String(token.user_id),
      nickname: datos.nickname,
      email: datos.email,
      accessToken: cifrarToken(token.access_token),
      refreshToken: cifrarToken(token.refresh_token),
      expiraEl: new Date(Date.now() + token.expires_in * 1000),
      estado: 'ACTIVA' as const,
      ultimoError: null,
      conectadaPor: usuarioId,
      conectadaEl: new Date(),
    });
    await this.cuentas.save(fila);
    this.logger.log(
      `Empresa ${empresaId} conectó la cuenta de MercadoPago ${token.user_id}.`,
    );
    return this.estado();
  }

  /** Lo que ve el panel del admin. Nunca incluye tokens. */
  async estado() {
    const empresaId = this.empresaActual();
    const cuenta = await this.cuentas.findOneBy({ empresaId });
    if (!cuenta || cuenta.estado === 'DESCONECTADA')
      return { conectada: false as const };
    return {
      conectada: true as const,
      mpUserId: cuenta.mpUserId,
      nickname: cuenta.nickname,
      email: cuenta.email,
      estado: cuenta.estado,
      expiraEl: cuenta.expiraEl,
      conectadaEl: cuenta.conectadaEl,
      ultimoError: cuenta.ultimoError,
    };
  }

  /**
   * Desconectar borra los tokens pero conserva la fila: queda el rastro de que esa empresa estuvo
   * conectada, con qué cuenta y quién la conectó.
   */
  async desconectar() {
    const empresaId = this.empresaActual();
    const cuenta = await this.cuentas.findOneBy({ empresaId });
    if (!cuenta) return { conectada: false as const };
    cuenta.accessToken = '';
    cuenta.refreshToken = '';
    cuenta.estado = 'DESCONECTADA';
    cuenta.ultimoError = null;
    await this.cuentas.save(cuenta);
    this.logger.log(`Empresa ${empresaId} desconectó su cuenta de MercadoPago.`);
    return { conectada: false as const };
  }

  /**
   * El token vigente de una empresa, renovándolo si está por vencer. Es el único punto por el que
   * el resto del sistema consigue credenciales para cobrar: el día que una playa necesite su
   * propia cuenta, se cambia acá y en ningún otro lado.
   */
  async tokenDeEmpresa(empresaId: string): Promise<string> {
    const cuenta = await this.cuentas.findOneBy({ empresaId });
    if (!cuenta || cuenta.estado === 'DESCONECTADA' || !cuenta.accessToken)
      throw new BadRequestException(
        'Esta empresa todavía no conectó su cuenta de MercadoPago.',
      );
    // Margen de un día: renovar antes evita que un cobro falle justo cuando vence.
    const margen = 24 * 60 * 60 * 1000;
    if (cuenta.expiraEl.getTime() - margen > Date.now())
      return descifrarToken(cuenta.accessToken);
    return this.renovar(cuenta);
  }

  private async renovar(cuenta: CuentaMercadoPago): Promise<string> {
    const { clientId, clientSecret } = this.ajustes();
    try {
      const token = await this.pedirToken({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: descifrarToken(cuenta.refreshToken),
      });
      cuenta.accessToken = cifrarToken(token.access_token);
      // MercadoPago rota el refresh token: si no se guarda el nuevo, la próxima renovación falla.
      if (token.refresh_token)
        cuenta.refreshToken = cifrarToken(token.refresh_token);
      cuenta.expiraEl = new Date(Date.now() + token.expires_in * 1000);
      cuenta.estado = 'ACTIVA';
      cuenta.ultimoError = null;
      await this.cuentas.save(cuenta);
      return token.access_token;
    } catch (error) {
      // Queda anotado para poder decirle al admin por qué dejó de cobrar, en vez de un error seco.
      cuenta.estado = 'ERROR';
      cuenta.ultimoError = 'No se pudo renovar el permiso con MercadoPago.';
      await this.cuentas.save(cuenta);
      this.logger.error(
        `No se pudo renovar el token de la empresa ${cuenta.empresaId}: ${error instanceof Error ? error.message : error}`,
      );
      throw new BadRequestException(
        'El permiso con MercadoPago dejó de ser válido. El administrador tiene que volver a conectar la cuenta.',
      );
    }
  }

  /**
   * Crea el pedido de pago y devuelve la URL a la que va a llegar el cliente. Esa URL es lo único
   * que hace falta: se dibuja como QR en el mostrador y se manda por WhatsApp sin cambiarle nada.
   *
   * `external_reference` es el id de nuestro cobro, y es lo que después permite preguntar por ese
   * pago puntual en vez de adivinar por importe y hora.
   */
  async crearPreferencia(
    empresaId: string,
    datos: {
      monto: number;
      referencia: string;
      descripcion: string;
      expiraEl: Date;
      volverA: string;
    },
  ): Promise<{ preferenceId: string; initPoint: string }> {
    const token = await this.tokenDeEmpresa(empresaId);
    const respuesta = await this.llamar(`${API}/checkout/preferences`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        items: [
          {
            title: datos.descripcion,
            quantity: 1,
            currency_id: 'ARS',
            unit_price: datos.monto,
          },
        ],
        external_reference: datos.referencia,
        // Que MercadoPago también lo venza evita que un QR viejo, sacado de una foto, se pueda
        // pagar días después.
        expires: true,
        expiration_date_to: datos.expiraEl.toISOString(),
        back_urls: {
          success: datos.volverA,
          pending: datos.volverA,
          failure: datos.volverA,
        },
      }),
    });
    const datosMp = (await respuesta.json()) as {
      id?: string | number;
      init_point?: string;
      sandbox_init_point?: string;
    };
    // Con credenciales de prueba la URL que sirve es la de sandbox.
    const initPoint = datosMp.init_point ?? datosMp.sandbox_init_point;
    if (!datosMp.id || !initPoint)
      throw new ServiceUnavailableException(
        'MercadoPago no devolvió el link de pago. Probá de nuevo.',
      );
    return { preferenceId: String(datosMp.id), initPoint };
  }

  /**
   * ¿Entró este cobro? Es la verificación de verdad: se le pregunta a MercadoPago por nuestra
   * referencia y se mira si hay un pago aprobado. No depende de que MercadoPago nos avise.
   */
  async buscarPagoAprobado(
    empresaId: string,
    referencia: string,
  ): Promise<{ id: string; monto: number } | null> {
    const token = await this.tokenDeEmpresa(empresaId);
    const url = new URL(`${API}/v1/payments/search`);
    url.searchParams.set('external_reference', referencia);
    url.searchParams.set('sort', 'date_created');
    url.searchParams.set('criteria', 'desc');
    const respuesta = await this.llamar(url.toString(), {
      headers: { authorization: `Bearer ${token}` },
    });
    const datos = (await respuesta.json()) as {
      results?: {
        id?: number | string;
        status?: string;
        transaction_amount?: number;
      }[];
    };
    const aprobado = (datos.results ?? []).find(
      (p) => p.status === 'approved' && p.id,
    );
    if (!aprobado) return null;
    return {
      id: String(aprobado.id),
      monto: Math.round(Number(aprobado.transaction_amount) || 0),
    };
  }

  private async pedirToken(
    cuerpo: Record<string, string>,
  ): Promise<RespuestaToken> {
    const respuesta = await this.llamar(`${API}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(cuerpo),
    });
    const datos = (await respuesta.json()) as Partial<RespuestaToken>;
    if (!datos.access_token || !datos.refresh_token || !datos.user_id)
      throw new ServiceUnavailableException(
        'MercadoPago no devolvió las credenciales esperadas. Probá conectar de nuevo.',
      );
    return {
      access_token: datos.access_token,
      refresh_token: datos.refresh_token,
      expires_in: Number(datos.expires_in) || VIGENCIA_POR_DEFECTO,
      user_id: datos.user_id,
    };
  }

  private async datosDeCuenta(accessToken: string) {
    try {
      const respuesta = await this.llamar(`${API}/users/me`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const datos = (await respuesta.json()) as {
        nickname?: string;
        email?: string;
      };
      return { nickname: datos.nickname ?? null, email: datos.email ?? null };
    } catch {
      // Son sólo para mostrar qué cuenta quedó conectada: no valen romper la conexión.
      return { nickname: null, email: null };
    }
  }

  private async llamar(url: string, init: RequestInit) {
    let respuesta: Response;
    try {
      respuesta = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
      });
    } catch (error) {
      this.logger.error(
        `No se pudo contactar a MercadoPago: ${error instanceof Error ? error.message : error}`,
      );
      throw new ServiceUnavailableException(
        'No se pudo contactar a MercadoPago. Probá de nuevo en un momento.',
      );
    }
    if (!respuesta.ok) {
      // El cuerpo de la respuesta no se loguea ni se reenvía: puede traer credenciales.
      await respuesta.body?.cancel();
      this.logger.error(`MercadoPago respondió ${respuesta.status} a ${url}`);
      if (respuesta.status === 400 || respuesta.status === 401)
        throw new BadRequestException(
          'MercadoPago rechazó la autorización. Volvé a intentar la conexión.',
        );
      throw new ServiceUnavailableException(
        'MercadoPago no está respondiendo. Probá de nuevo en un momento.',
      );
    }
    return respuesta;
  }
}
