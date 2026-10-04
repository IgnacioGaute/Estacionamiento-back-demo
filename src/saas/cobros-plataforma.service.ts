import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SuscripcionesService, ResumenCuenta } from './suscripciones.service';
import { MercadoPagoPlataforma } from './mercadopago-plataforma';
import { hoyAR, sumarMeses } from './estado-cuenta';

// Cuántos días vale un link de pago: si el cliente lo abre después, se genera otro.
const DIAS_DEL_LINK = 3;

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

  /** Lo que hay para pagar ahora: lo que debe o, si está al día, su próximo período. */
  private aPagar(cuenta: ResumenCuenta) {
    const pendiente = cuenta.facturaPendiente;
    if (pendiente) return pendiente;
    if (
      ['PRUEBA', 'AL_DIA', 'VENCIDA', 'SUSPENDIDA'].includes(cuenta.estado) &&
      cuenta.importePeriodo > 0 &&
      cuenta.venceEl &&
      cuenta.proximoVencimiento
    )
      return {
        importe: cuenta.importePeriodo,
        desde: cuenta.proximoVencimiento,
        hasta: sumarMeses(cuenta.venceEl, cuenta.periodo.meses),
      };
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
