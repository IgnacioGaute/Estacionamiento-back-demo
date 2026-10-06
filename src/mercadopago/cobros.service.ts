import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CobroMercadoPago } from './entities/cobro-mercadopago.entity';
import { MercadoPagoService } from './mercadopago.service';
import { CajasQrService } from './cajas-qr.service';
import { TicketsService } from '../tickets/tickets.service';
import { CuentasService } from '../cuentas/cuentas.service';
import { tenantContext } from '../tenancy/tenant-context';

// Cuántos minutos vale el importe que se le mostró al cliente. La tarifa sigue corriendo mientras
// él paga: si tarda más que esto, el cajero regenera el QR. Y si paga igual después, la plata
// entra como pago parcial y queda un saldo chico, que es preferible a cobrarle de más o de menos.
const MINUTOS_DE_VIGENCIA = 15;

// El cobro por QR de una estadía: generarlo, consultarlo y acreditarlo.
//
// La idea que sostiene todo esto: el pago se registra como un movimiento más de la estadía, no
// como el cierre. El cajero cierra después, cuando ve que no queda saldo. Así un cliente que
// tarda y cruza un escalón de tarifa no rompe la operación —queda una diferencia chica— y no hace
// falta cerrar la estadía sin un cajero detrás.
@Injectable()
export class CobrosMercadoPagoService {
  private readonly logger = new Logger(CobrosMercadoPagoService.name);

  constructor(
    @InjectRepository(CobroMercadoPago)
    private readonly cobros: Repository<CobroMercadoPago>,
    private readonly mercadoPago: MercadoPagoService,
    private readonly tickets: TicketsService,
    private readonly config: ConfigService,
    private readonly cuentas: CuentasService,
    // Opcional: sin cajas (o en las pruebas que no las usan) el QR es el link de siempre.
    @Optional() private readonly cajasQr?: CajasQrService,
  ) {}

  private scope() {
    const scope = tenantContext.getStore();
    if (!scope?.empresaId || !scope?.playaId)
      throw new BadRequestException('Elegí una playa para continuar.');
    return scope;
  }

  /**
   * Genera el QR de cobro. Sirve para los dos tipos de estadía —la que se cobra por hora al salir
   * y el abono por día, semana o mes— y para un pago a la cuenta de un inquilino, que puede ser
   * de cualquier importe (una parte, varios meses, de más), así que ahí el importe lo pone el
   * mostrador.
   */
  async crear(
    registrationId: string,
    tipo: 'HORA' | 'ABONO' | 'INQUILINO',
    usuarioId: string,
    inquilino?: { monto?: number; receiptIds?: string[]; nota?: string },
  ) {
    const { empresaId, playaId } = this.scope();
    const { monto, patente } =
      tipo === 'INQUILINO'
        ? await this.datosDeInquilino(registrationId, inquilino?.monto)
        : tipo === 'ABONO'
          ? await this.datosDeAbono(registrationId)
          : await this.datosDeEstadia(registrationId);

    // Un solo QR vivo por estadía: si había otro pendiente se cancela, para que no queden dos
    // códigos dando vueltas por el mismo auto. Una orden QR se cancela también en MercadoPago.
    if (this.cajasQr) {
      const previos = await this.cobros.findBy({
        registrationId,
        estado: 'PENDIENTE',
      });
      for (const previo of previos)
        if (previo.ordenId)
          await this.cajasQr.cancelarOrden(empresaId, previo.ordenId);
    }
    await this.cobros.update(
      { registrationId, estado: 'PENDIENTE' },
      { estado: 'CANCELADO' },
    );

    const expiraEl = new Date(Date.now() + MINUTOS_DE_VIGENCIA * 60 * 1000);
    // Se guarda primero para tener el id que viaja como referencia a MercadoPago.
    const cobro = await this.cobros.save(
      this.cobros.create({
        playaId,
        registrationId,
        tipo,
        monto,
        detalle:
          tipo === 'INQUILINO'
            ? {
                receiptIds: inquilino?.receiptIds ?? [],
                nota: inquilino?.nota?.trim() || null,
              }
            : null,
        estado: 'PENDIENTE',
        preferenceId: '',
        initPoint: '',
        expiraEl,
        creadoPor: usuarioId,
      }),
    );

    const descripcion =
      tipo === 'INQUILINO'
        ? `Cochera - ${patente}`
        : `Estacionamiento - ${patente}`;

    // Con caja de la playa, un QR estándar que se paga desde cualquier banco o billetera. Si la
    // orden falla, se sigue con el link de siempre: mejor un QR que solo paga MercadoPago que no
    // poder cobrar.
    const caja = playaId
      ? await this.cajasQr?.cajaDePlaya(empresaId, playaId)
      : null;
    if (caja && this.cajasQr) {
      try {
        const { ordenId, qrData } = await this.cajasQr.crearOrden(
          empresaId,
          caja,
          {
            monto,
            referencia: cobro.id,
            descripcion,
            minutos: MINUTOS_DE_VIGENCIA,
          },
        );
        cobro.ordenId = ordenId;
        cobro.qrData = qrData;
        await this.cobros.save(cobro);
        return this.aVista(cobro);
      } catch (error) {
        this.logger.warn(
          `No se pudo crear la orden QR del cobro ${cobro.id}; se usa el link de pago: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    try {
      const { preferenceId, initPoint } =
        await this.mercadoPago.crearPreferencia(empresaId, {
          monto,
          referencia: cobro.id,
          descripcion,
          expiraEl,
          volverA: this.config.get<string>('MERCADOPAGO_REDIRECT_URI') ?? '',
        });
      cobro.preferenceId = preferenceId;
      cobro.initPoint = initPoint;
      await this.cobros.save(cobro);
    } catch (error) {
      // Si MercadoPago no dio el link, el cobro no existe para nadie: se cancela para no dejar
      // filas pendientes que nunca se van a poder pagar.
      cobro.estado = 'CANCELADO';
      await this.cobros.save(cobro);
      throw error;
    }

    return this.aVista(cobro);
  }

  /** Lo que falta cobrar de una estadía por hora, al salir. */
  private async datosDeEstadia(registrationId: string) {
    const resumen = await this.tickets.getCloseSummary(registrationId);
    if (resumen.saldoACobrar <= 0)
      throw new BadRequestException(
        'No queda saldo por cobrar en esta estadía.',
      );
    return {
      monto: resumen.saldoACobrar,
      patente: resumen.registration?.licensePlateOriginal ?? 'Sin patente',
    };
  }

  /** Un pago a la cuenta de un inquilino: el importe elegido en el mostrador. */
  private async datosDeInquilino(customerId: string, monto?: number) {
    if (!monto || !Number.isInteger(monto) || monto < 1)
      throw new BadRequestException(
        'Ingresá el importe a cobrar, en pesos enteros.',
      );
    const { nombre } = await this.cuentas.validarCobroQr(customerId);
    // `patente` se usa como nombre visible en la descripción del pago.
    return { monto, patente: nombre };
  }

  /** El precio de un abono por día, semana o mes, que se cobra entero y por adelantado. */
  private async datosDeAbono(registrationId: string) {
    const abono = await this.tickets.getRegistrationForDay(registrationId);
    if (!abono) throw new NotFoundException('Abono no encontrado.');
    if (abono.paid)
      throw new BadRequestException('Este abono ya figura pagado.');
    if (abono.price <= 0)
      throw new BadRequestException('Este abono no tiene importe para cobrar.');
    return {
      monto: abono.price,
      patente: abono.vehiclePlateCustomer || 'Sin patente',
    };
  }

  /**
   * Consulta el estado del cobro contra MercadoPago y, si está pagado, lo acredita.
   * Es la verificación de verdad: no depende de que MercadoPago nos avise.
   */
  async consultar(id: string) {
    const { empresaId } = this.scope();
    const cobro = await this.cobros.findOneBy({ id });
    if (!cobro) throw new NotFoundException('Cobro no encontrado.');
    if (cobro.estado === 'ACREDITADO' || cobro.estado === 'CANCELADO')
      return this.aVista(cobro);

    // Un cobro con caja se consulta por su orden; uno con link, por la referencia.
    if (cobro.ordenId && this.cajasQr) {
      const orden = await this.cajasQr.consultarOrden(empresaId, cobro.ordenId);
      if (orden.pagada && orden.pagoId)
        return this.acreditar(cobro, { id: orden.pagoId, monto: orden.monto });
    } else {
      const pago = await this.mercadoPago.buscarPagoAprobado(
        empresaId,
        cobro.id,
      );
      if (pago) return this.acreditar(cobro, pago);
    }

    // Vencido y sin pago: se marca, pero recién después de haberle preguntado a MercadoPago. Al
    // revés se correría el riesgo de dar por perdido un pago que sí entró sobre la hora.
    if (cobro.expiraEl.getTime() <= Date.now()) {
      cobro.estado = 'VENCIDO';
      await this.cobros.save(cobro);
    }
    return this.aVista(cobro);
  }

  async cancelar(id: string) {
    const cobro = await this.cobros.findOneBy({ id });
    if (!cobro) throw new NotFoundException('Cobro no encontrado.');
    if (cobro.estado === 'PENDIENTE') {
      cobro.estado = 'CANCELADO';
      await this.cobros.save(cobro);
      // Que el QR estándar tampoco se pueda pagar después.
      if (cobro.ordenId && this.cajasQr)
        await this.cajasQr.cancelarOrden(this.scope().empresaId, cobro.ordenId);
    }
    return this.aVista(cobro);
  }

  /**
   * Registra el pago una sola vez. La toma del cobro es un UPDATE condicional: si otra consulta
   * simultánea llegó primero, este no actualiza ninguna fila y no registra nada. El índice único
   * sobre mpPaymentId es la segunda red, a nivel base.
   */
  private async acreditar(
    cobro: CobroMercadoPago,
    pago: { id: string; monto: number },
  ) {
    const tomado = await this.cobros.update(
      { id: cobro.id, estado: 'PENDIENTE' },
      {
        estado: 'ACREDITADO',
        mpPaymentId: pago.id,
        acreditadoEl: new Date(),
      },
    );
    if (!tomado.affected)
      return this.aVista(await this.cobros.findOneBy({ id: cobro.id }));

    try {
      if (cobro.tipo === 'INQUILINO') {
        // Un pago más de la cuenta corriente, con MercadoPago como medio y el id del cobro como
        // solicitud: aunque este paso se repitiera, el pago se asienta una sola vez.
        await this.cuentas.registrarPagoMercadoPago(
          cobro.registrationId,
          {
            importe: pago.monto || cobro.monto,
            receiptIds: cobro.detalle?.receiptIds ?? [],
            nota: cobro.detalle?.nota ?? null,
            cobroId: cobro.id,
          },
          cobro.creadoPor,
        );
      } else if (cobro.tipo === 'ABONO') {
        // El abono no pasa por el libro de movimientos: se marca pagado, igual que cuando se
        // cobra en efectivo, y con el medio puesto no suma a la caja física.
        await this.tickets.updateTicketStatus(cobro.registrationId, {
          paid: true,
          paymentMetodo: 'MERCADOPAGO',
        });
      } else {
        // Se registra lo que MercadoPago dice que entró, no lo que habíamos pedido: si por lo que
        // fuera difieren, el libro tiene que reflejar la plata real.
        await this.tickets.registrarPagoExterno(
          cobro.registrationId,
          pago.monto || cobro.monto,
          'MERCADOPAGO',
          `MercadoPago ${pago.id}`,
          cobro.creadoPor ?? '',
        );
      }
    } catch (error) {
      // Se devuelve el cobro a pendiente para que el próximo intento pueda registrarlo: quedaría
      // cobrado en MercadoPago y sin asentar en el libro, que es lo peor que puede pasar acá.
      await this.cobros.update(
        { id: cobro.id },
        { estado: 'PENDIENTE', mpPaymentId: null, acreditadoEl: null },
      );
      this.logger.error(
        `El pago ${pago.id} del cobro ${cobro.id} no se pudo asentar: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }

    this.logger.log(
      `Cobro ${cobro.id} acreditado con el pago ${pago.id} de MercadoPago.`,
    );
    return this.aVista(await this.cobros.findOneBy({ id: cobro.id }));
  }

  /**
   * Lo que ve el mostrador. El id de pago no se expone: no le sirve de nada al cajero. Para un
   * inquilino acreditado va además el recibo del pago asentado, para entregárselo en el momento.
   */
  private async aVista(cobro: CobroMercadoPago | null) {
    if (!cobro) throw new NotFoundException('Cobro no encontrado.');
    return {
      id: cobro.id,
      estado: cobro.estado,
      monto: cobro.monto,
      initPoint: cobro.initPoint,
      // Lo que se dibuja: el código estándar si la playa tiene caja (lo paga cualquier banco o
      // billetera), si no el link de MercadoPago.
      qr: cobro.qrData || cobro.initPoint,
      interoperable: !!cobro.qrData,
      expiraEl: cobro.expiraEl,
      acreditadoEl: cobro.acreditadoEl,
      ...(cobro.tipo === 'INQUILINO' && cobro.estado === 'ACREDITADO'
        ? { recibo: await this.cuentas.reciboDeCobro(cobro.id) }
        : {}),
    };
  }
}
