import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SuscripcionesService, ResumenCuenta } from './suscripciones.service';
import { DireccionSucursal, MercadoPagoPlataforma, OrdenQr } from './mercadopago-plataforma';
import { hoyAR } from './estado-cuenta';
import {
  ciudadesMp,
  direccionDeUbicacion,
  provinciasMp,
  validarDireccionMp,
} from 'src/mercadopago/ubicaciones-mp';

// Cuántos días vale un link de pago: si el cliente lo abre después, se genera otro.
const DIAS_DEL_LINK = 3;
// Cuánto vale un QR: lo que se tarda en abrir la app del banco y pagar. Después se pide otro.
const MINUTOS_DEL_QR = 15;
// Si la plataforma tiene caja QR se le pregunta a MercadoPago: la respuesta se recuerda un rato.
const RECORDAR_CAJA_QR_MS = 10 * 60 * 1000;
const ORDEN_CERRADA = ['expired', 'canceled', 'cancelled', 'refunded', 'failed'];

// La referencia de un QR: «plan_<empresa>_<desde sin guiones>». Distinta de la del link
// («plan:…»): un pago del QR se asienta con el id de pago que trae la orden (al consultarla), no
// por el aviso de pagos, para que el mismo pago no entre dos veces con dos ids distintos.
const referenciaQr = (empresaId: string, desde: string) =>
  `plan_${empresaId}_${desde.replace(/-/g, '')}`;

const fechaCorta = (ymd: string) => {
  const [, m, d] = ymd.split('-');
  return `${Number(d)}/${Number(m)}`;
};

// Cobrar el plan con MercadoPago, de dos formas:
//
// - Débito automático: una suscripción de MercadoPago que el cliente confirma una vez con su
//   tarjeta. El primer cobro es el día de su próximo vencimiento; después, uno por período (cada
//   mes, cada 3 meses o cada año, con el descuento de su período de pago).
// - Pago con MercadoPago: un link por lo que debe (o por su próximo período, si quiere adelantarlo).
//
// Cada pago lleva una referencia nuestra («plan:<empresa>:<desde>» o «debito:<empresa>») y se
// asienta solo, por cualquiera de tres caminos que pueden llegar juntos: el aviso de MercadoPago,
// la verificación cuando el cliente vuelve de pagar y la revisión periódica. Ninguno se cree lo
// que le dicen: siempre se le pregunta a MercadoPago con el token propio, y el pago se asienta
// una sola vez por su id.
@Injectable()
export class CobrosPlataformaService {
  private readonly logger = new Logger(CobrosPlataformaService.name);

  private cajaQr: { disponible: boolean; hasta: number } | null = null;

  constructor(
    private readonly suscripciones: SuscripcionesService,
    private readonly mp: MercadoPagoPlataforma,
  ) {}

  configurado() {
    return this.mp.configurado();
  }

  clavePublica() {
    return this.mp.clavePublica();
  }

  /**
   * Lo que hay para pagar ahora: lo que debe o, si está al día, su próxima factura (en prueba, el
   * primer pago: lo que queda del mes cuando termina la prueba, proporcional).
   */
  private aPagar(cuenta: ResumenCuenta) {
    const pendiente = cuenta.facturaPendiente;
    if (pendiente) return pendiente;
    if (
      ['PRUEBA', 'AL_DIA', 'VENCIDA', 'SUSPENDIDA'].includes(cuenta.estado) &&
      cuenta.proximaFactura &&
      cuenta.proximaFactura.importe > 0
    )
      return cuenta.proximaFactura;
    return null;
  }

  async pagar(empresaId: string) {
    const cuenta = await this.suscripciones.resumen(empresaId);
    if (cuenta.estado === 'BONIFICADA')
      throw new BadRequestException(
        'Tu cuenta está bonificada: no tenés nada para pagar.',
      );
    const a = this.aPagar(cuenta);
    if (!a?.importe)
      throw new BadRequestException('No tenés nada para pagar por ahora.');
    return this.mp.crearPago({
      referencia: `plan:${empresaId}:${a.desde}`,
      titulo: `Plan del sistema de estacionamiento · del ${fechaCorta(a.desde)} al ${fechaCorta(a.hasta)}`,
      importe: a.importe,
      vence: new Date(Date.now() + DIAS_DEL_LINK * 24 * 60 * 60 * 1000),
    });
  }

  // ── QR para pagar el plan ──────────────────────────────────────────────────────────────────────
  // Un QR estándar (se paga desde cualquier banco o billetera) que cobra en la cuenta de MercadoPago
  // de la PLATAFORMA, nunca en la que conectó la empresa. Necesita una sucursal y una caja en esa
  // cuenta, que el super admin crea una vez con su dirección.

  /** Si la plataforma ya tiene su caja QR (para ofrecer el QR en «Pagar tu plan»). Nunca falla. */
  async qrDisponible() {
    if (!this.mp.configurado()) return false;
    if (this.cajaQr && this.cajaQr.hasta > Date.now()) return this.cajaQr.disponible;
    let disponible = false;
    try {
      disponible = !!(await this.mp.cajaQr());
    } catch {
      disponible = false;
    }
    // Sin caja se vuelve a preguntar en un minuto: puede estar recién creándose.
    this.cajaQr = { disponible, hasta: Date.now() + (disponible ? RECORDAR_CAJA_QR_MS : 60_000) };
    return disponible;
  }

  /** Para el super admin: si está configurado el MercadoPago de la plataforma y su caja QR. */
  async cajaQrPlataforma() {
    if (!this.mp.configurado()) return { configurado: false, caja: null };
    const caja = await this.mp.cajaQr();
    this.cajaQr = { disponible: !!caja, hasta: Date.now() + RECORDAR_CAJA_QR_MS };
    return { configurado: true, caja: caja ? { direccion: caja.direccion } : null };
  }

  provinciasQr() {
    return provinciasMp();
  }

  ciudadesQr(provinciaId: string) {
    return ciudadesMp(provinciaId);
  }

  async crearCajaQrPlataforma(direccion: DireccionSucursal) {
    if (!this.mp.configurado())
      throw new BadRequestException(
        'Primero configurá el MercadoPago de la plataforma (MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN).',
      );
    await validarDireccionMp(direccion);
    await this.mp.crearCajaQr(direccion, 'Sistema de estacionamiento');
    this.cajaQr = null;
    return this.cajaQrPlataforma();
  }

  /** Con la ubicación del dispositivo; si no se reconoce la localidad, vuelve lo detectado. */
  async crearCajaQrConUbicacion(latitud: number, longitud: number) {
    const resultado = await direccionDeUbicacion(
      latitud,
      longitud,
      null,
      'La ubicación no es de Argentina. Completá la dirección a mano.',
    );
    if (!resultado.direccion)
      return { creada: false as const, motivo: resultado.motivo, sugerencia: resultado.sugerencia };
    return { creada: true as const, ...(await this.crearCajaQrPlataforma(resultado.direccion)) };
  }

  /**
   * Un QR por lo que hay para pagar ahora (lo mismo que el link). El anterior que quedó abierto se
   * revisa primero: si ya se pagó, se asienta y no se genera otro; si no, se cancela.
   */
  async pagarConQr(empresaId: string) {
    const cuenta = await this.suscripciones.resumen(empresaId);
    if (cuenta.estado === 'BONIFICADA')
      throw new BadRequestException(
        'Tu cuenta está bonificada: no tenés nada para pagar.',
      );
    const a = this.aPagar(cuenta);
    if (!a?.importe)
      throw new BadRequestException('No tenés nada para pagar por ahora.');
    if (!(await this.qrDisponible()))
      throw new BadRequestException(
        'El pago con QR no está disponible por ahora. Pagá con MercadoPago o por transferencia.',
      );
    const anterior = await this.suscripciones.ordenQr(empresaId);
    if (anterior) {
      const revisada = await this.mp
        .ordenQr(anterior)
        .then((orden) => this.asentarOrdenQr(empresaId, orden))
        .catch(() => null);
      if (revisada?.pagada)
        throw new BadRequestException('Ya se acreditó tu pago con QR.');
      if (revisada && !revisada.vencida) await this.mp.cancelarOrdenQr(anterior);
    }
    const orden = await this.mp.crearOrdenQr({
      referencia: referenciaQr(empresaId, a.desde),
      descripcion: `Plan del sistema de estacionamiento · del ${fechaCorta(a.desde)} al ${fechaCorta(a.hasta)}`,
      importe: a.importe,
      minutos: MINUTOS_DEL_QR,
      idempotencia: randomUUID(),
    });
    await this.suscripciones.guardarOrdenQr(empresaId, orden.ordenId);
    return {
      ordenId: orden.ordenId,
      qrData: orden.qrData,
      importe: a.importe,
      desde: a.desde,
      hasta: a.hasta,
      vence: new Date(Date.now() + MINUTOS_DEL_QR * 60 * 1000).toISOString(),
    };
  }

  /**
   * Mientras se muestra el QR: si ya se pagó, se asienta. Solo se consulta una orden con la
   * referencia de esta empresa, que la pone el servidor al crearla.
   */
  async verificarQr(empresaId: string, ordenId: string) {
    const orden = await this.mp.ordenQr(ordenId);
    if (!orden.referencia?.startsWith(`plan_${empresaId}_`))
      throw new NotFoundException('No encontramos ese QR.');
    return this.asentarOrdenQr(empresaId, orden);
  }

  private async asentarOrdenQr(empresaId: string, orden: OrdenQr) {
    if (orden.pagada && orden.pagoId) {
      const acreditado = await this.suscripciones.acreditarPagoMercadoPago(empresaId, {
        id: orden.pagoId,
        monto: orden.monto,
        fecha: hoyAR(),
        debito: false,
      });
      await this.suscripciones.olvidarOrdenQr(empresaId, orden.id);
      return { pagada: true, vencida: false, acreditado };
    }
    const vencida = ORDEN_CERRADA.includes(orden.estado);
    if (vencida) await this.suscripciones.olvidarOrdenQr(empresaId, orden.id);
    return { pagada: false, vencida, acreditado: false };
  }

  /**
   * Activa el débito automático. Solo con la cuenta al día o en prueba: lo que ya se debe se paga
   * aparte, así el débito arranca justo en el próximo vencimiento y cada mes cae ese mismo día.
   *
   * Con `tarjeta` (token del formulario de MercadoPago en el panel) queda activo en el acto, sin
   * cuenta de MercadoPago. Sin tarjeta, devuelve el link donde el cliente lo confirma con su cuenta.
   */
  async activarDebito(
    empresaId: string,
    email: string,
    actor: string | null,
    tarjeta?: string,
  ) {
    const cuenta = await this.suscripciones.resumen(empresaId);
    if (cuenta.estado === 'BONIFICADA')
      throw new BadRequestException(
        'Tu cuenta está bonificada: no tenés nada para pagar.',
      );
    if (cuenta.estado === 'SIN_ACTIVAR' || !cuenta.proximoVencimiento)
      throw new BadRequestException('Tu cuenta todavía no arrancó.');
    if (!cuenta.mensual)
      throw new BadRequestException(
        'Todavía no tenés un plan elegido. Escribinos y lo vemos juntos.',
      );
    if (cuenta.debito?.estado === 'authorized')
      throw new BadRequestException('Ya tenés el débito automático activo.');
    const debe =
      (cuenta.facturaPendiente && cuenta.facturaPendiente.desde <= hoyAR()) ||
      cuenta.estado === 'VENCIDA' ||
      cuenta.estado === 'SUSPENDIDA';
    if (debe)
      throw new BadRequestException({
        code: 'PAGO_PENDIENTE',
        message:
          'Primero pagá lo pendiente; después activás el débito para los meses que siguen.',
      });
    // El débito cobra siempre el mismo importe, el día 1. El primer pago es proporcional (desde
    // el alta hasta fin de mes): se paga aparte y recién después arranca el débito.
    if (!cuenta.pagadoHasta)
      throw new BadRequestException({
        code: 'PRIMER_PAGO_PENDIENTE',
        message:
          'El débito automático se activa después de tu primer pago: desde ahí se cobra solo el día 1 de cada mes.',
      });

    // Uno que quedó a medio confirmar (o que pausó desde MercadoPago) se reemplaza: no tiene que
    // quedar otro vivo que después cobre por su lado.
    const previo = await this.suscripciones.datosDebito(empresaId);
    if (
      previo.debitoId &&
      (previo.debitoEstado === 'pending' || previo.debitoEstado === 'paused')
    )
      await this.mp
        .actualizarSuscripcion(previo.debitoId, { estado: 'cancelled' })
        .catch(() => undefined);

    // Un cobro por período: cada 3 meses con el descuento si paga trimestral.
    const debito = await this.mp.crearSuscripcion({
      referencia: `debito:${empresaId}`,
      motivo:
        cuenta.periodo.meses > 1
          ? `Plan del sistema de estacionamiento (${cuenta.periodo.nombre.toLowerCase()})`
          : 'Plan del sistema de estacionamiento',
      email,
      importe: cuenta.importePeriodo,
      meses: cuenta.periodo.meses,
      inicio: cuenta.proximoVencimiento,
      tarjeta,
    });
    if (!debito.id || (debito.estado === 'pending' && !debito.url))
      throw new ServiceUnavailableException(
        'MercadoPago no devolvió el débito para confirmar. Probá de nuevo en un momento.',
      );
    await this.suscripciones.guardarDebito(
      empresaId,
      {
        debitoId: debito.id,
        debitoEstado: debito.estado,
        debitoEmail: email,
        debitoUrl: debito.estado === 'pending' ? debito.url : null,
        debitoImporte: debito.importe || cuenta.importePeriodo,
      },
      actor,
    );
    return {
      estado: debito.estado,
      url: debito.estado === 'pending' ? debito.url : null,
    };
  }

  async desactivarDebito(empresaId: string, actor: string | null) {
    const d = await this.suscripciones.datosDebito(empresaId);
    if (!d.debitoId || d.debitoEstado === 'cancelled') return;
    await this.mp.actualizarSuscripcion(d.debitoId, { estado: 'cancelled' });
    await this.suscripciones.guardarDebito(
      empresaId,
      { debitoEstado: 'cancelled', debitoUrl: null },
      actor,
    );
  }

  /**
   * Le pregunta a MercadoPago por los pagos de una empresa y asienta los aprobados: los cobros de
   * su débito automático y los pagos con link del período que debe. De paso actualiza el estado
   * del débito y, si cambió el plan, su importe.
   */
  async conciliar(empresaId: string) {
    if (!this.mp.configurado()) return { acreditados: 0 };
    let acreditados = 0;
    // Un QR abierto: por si se pagó y se cerró la pantalla antes de que se confirme.
    const qrAbierto = await this.suscripciones.ordenQr(empresaId);
    if (qrAbierto) {
      const qr = await this.asentarOrdenQr(empresaId, await this.mp.ordenQr(qrAbierto));
      if (qr.acreditado) acreditados++;
    }
    const d = await this.suscripciones.datosDebito(empresaId);
    if (d.debitoId && d.debitoEstado !== 'cancelled') {
      const debito = await this.mp.suscripcion(d.debitoId);
      if (debito.estado !== d.debitoEstado)
        await this.suscripciones.guardarDebito(
          empresaId,
          {
            debitoEstado: debito.estado,
            ...(debito.estado !== 'pending' ? { debitoUrl: null } : {}),
          },
          null,
        );
      for (const cobro of await this.mp.cobrosDeSuscripcion(d.debitoId))
        if (
          cobro.pago?.estado === 'approved' &&
          (await this.suscripciones.acreditarPagoMercadoPago(empresaId, {
            ...cobro.pago,
            debito: true,
          }))
        )
          acreditados++;
      if (debito.estado === 'authorized')
        await this.sincronizarImporte(empresaId, d.debitoId, debito.importe);
    }

    const cuenta = await this.suscripciones.resumen(empresaId);
    const desde =
      cuenta.facturaPendiente?.desde ?? cuenta.proximoVencimiento ?? null;
    if (desde)
      for (const pago of await this.mp.pagosConReferencia(
        `plan:${empresaId}:${desde}`,
      ))
        if (
          pago.estado === 'approved' &&
          (await this.suscripciones.acreditarPagoMercadoPago(empresaId, {
            ...pago,
            debito: false,
          }))
        )
          acreditados++;
    return { acreditados };
  }

  /** Todas las cuentas con débito o con algo pendiente. Cada una por su lado: un error no frena al resto. */
  async conciliarTodas() {
    if (!this.mp.configurado()) return { acreditados: 0 };
    let acreditados = 0;
    for (const empresaId of await this.suscripciones.cuentasParaConciliar()) {
      try {
        acreditados += (await this.conciliar(empresaId)).acreditados;
      } catch (error) {
        this.logger.error(
          `No se pudieron revisar los pagos de la empresa ${empresaId}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    if (acreditados)
      this.logger.log(`Se acreditaron ${acreditados} pagos de MercadoPago.`);
    return { acreditados };
  }

  /** Si cambió lo que paga por período, MercadoPago tiene que cobrar lo nuevo desde el próximo débito. */
  async sincronizarImporte(
    empresaId: string,
    debitoId?: string,
    importeEnMp?: number,
  ) {
    if (!this.mp.configurado()) return;
    const d = debitoId
      ? { debitoId, debitoImporte: importeEnMp ?? null }
      : await this.suscripciones.datosDebito(empresaId);
    if (!d.debitoId) return;
    const cuenta = await this.suscripciones.resumen(empresaId);
    const importe = cuenta.importePeriodo;
    if (cuenta.debito?.estado !== 'authorized' || !importe) return;
    if (d.debitoImporte === importe) return;
    await this.mp.actualizarSuscripcion(d.debitoId, { importe });
    await this.suscripciones.guardarDebito(
      empresaId,
      { debitoImporte: importe },
      null,
    );
  }

  /**
   * Un aviso de MercadoPago. Solo dice «pasó algo con tal id»: se consulta con el token propio y
   * se actúa sobre lo que responda la API.
   */
  async procesarAviso(tipo: string, id: string) {
    if (!this.mp.configurado() || !id) return;
    if (tipo === 'payment') {
      const pago = await this.mp.pago(id);
      const empresaId = empresaDeReferencia(pago.referencia);
      if (empresaId && pago.estado === 'approved')
        await this.suscripciones.acreditarPagoMercadoPago(empresaId, {
          ...pago,
          debito: !!pago.referencia?.startsWith('debito:'),
        });
    } else if (tipo === 'subscription_authorized_payment') {
      const cobro = await this.mp.cobroDeSuscripcion(id);
      const empresaId = await this.suscripciones.empresaDeDebito(
        cobro.suscripcionId,
      );
      if (empresaId && cobro.pago?.estado === 'approved')
        await this.suscripciones.acreditarPagoMercadoPago(empresaId, {
          ...cobro.pago,
          debito: true,
        });
    } else if (tipo === 'subscription_preapproval') {
      const debito = await this.mp.suscripcion(id);
      const empresaId = await this.suscripciones.empresaDeDebito(debito.id);
      if (!empresaId) return;
      const d = await this.suscripciones.datosDebito(empresaId);
      if (d.debitoId === debito.id && d.debitoEstado !== debito.estado)
        await this.suscripciones.guardarDebito(
          empresaId,
          {
            debitoEstado: debito.estado,
            ...(debito.estado !== 'pending' ? { debitoUrl: null } : {}),
          },
          null,
        );
    }
  }
}

/** «plan:<empresa>:<desde>» o «debito:<empresa>» → la empresa. Cualquier otra cosa no es nuestra. */
export function empresaDeReferencia(referencia: string | null | undefined) {
  const m = /^(?:plan|debito):([0-9a-f-]{36})(?::|$)/i.exec(referencia ?? '');
  return m ? m[1].toLowerCase() : null;
}
