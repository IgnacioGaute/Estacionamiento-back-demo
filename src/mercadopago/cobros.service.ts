import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CobroMercadoPago } from './entities/cobro-mercadopago.entity';
import { MercadoPagoService } from './mercadopago.service';
import { TicketsService } from '../tickets/tickets.service';
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
  ) {}

  private scope() {
    const scope = tenantContext.getStore();
    if (!scope?.empresaId || !scope?.playaId)
      throw new BadRequestException('Elegí una playa para continuar.');
    return scope;
  }

  /** Genera el QR de una estadía por lo que falta cobrar. */
  async crear(registrationId: string, usuarioId: string) {
    const { empresaId, playaId } = this.scope();
    const resumen = await this.tickets.getCloseSummary(registrationId);
    const monto = resumen.saldoACobrar;
    if (monto <= 0)
      throw new BadRequestException(
        'No queda saldo por cobrar en esta estadía.',
      );

    // Un solo QR vivo por estadía: si había otro pendiente se cancela, para que no queden dos
    // códigos dando vueltas por el mismo auto.
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
        monto,
        estado: 'PENDIENTE',
        preferenceId: '',
        initPoint: '',
        expiraEl,
        creadoPor: usuarioId,
      }),
    );

    try {
      const patente =
        resumen.registration?.licensePlateOriginal ?? 'Sin patente';
      const { preferenceId, initPoint } =
        await this.mercadoPago.crearPreferencia(empresaId, {
          monto,
          referencia: cobro.id,
          descripcion: `Estacionamiento - ${patente}`,
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

    const pago = await this.mercadoPago.buscarPagoAprobado(empresaId, cobro.id);
    if (pago) return this.acreditar(cobro, pago);

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
    if (!tomado.affected) return this.aVista(await this.cobros.findOneBy({ id: cobro.id }));

    try {
      // Se registra lo que MercadoPago dice que entró, no lo que habíamos pedido: si por lo que
      // fuera difieren, el libro tiene que reflejar la plata real.
      await this.tickets.registrarPagoExterno(
        cobro.registrationId,
        pago.monto || cobro.monto,
        'MERCADOPAGO',
        `MercadoPago ${pago.id}`,
        cobro.creadoPor ?? '',
      );
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

  /** Lo que ve el mostrador. El id de pago no se expone: no le sirve de nada al cajero. */
  private aVista(cobro: CobroMercadoPago | null) {
    if (!cobro) throw new NotFoundException('Cobro no encontrado.');
    return {
      id: cobro.id,
      estado: cobro.estado,
      monto: cobro.monto,
      initPoint: cobro.initPoint,
      expiraEl: cobro.expiraEl,
      acreditadoEl: cobro.acreditadoEl,
    };
  }
}
