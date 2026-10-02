import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SuscripcionesService } from './suscripciones.service';
import { CobrosPlataformaService } from './cobros-plataforma.service';

// Las tareas de las cuentas con la plataforma. Corren sin tenantContext a propósito —trabajan
// sobre todas las empresas, con el rol dueño— y son idempotentes, así que reiniciar o tener dos
// instancias no duplica nada.
@Injectable()
export class SuscripcionesScheduler {
  private readonly logger = new Logger(SuscripcionesScheduler.name);

  constructor(
    private readonly suscripciones: SuscripcionesService,
    private readonly cobros: CobrosPlataformaService,
  ) {}

  /**
   * Una vez por día, de madrugada: primero asienta lo que se pagó por MercadoPago (para no
   * suspender a nadie que ya pagó) y después emite facturas y suspende lo que pasó la gracia.
   */
  @Cron('0 5 * * *', { timeZone: 'America/Argentina/Buenos_Aires' })
  async revisar() {
    await this.buscarPagos();
    try {
      await this.suscripciones.revisarVencimientos();
    } catch (error) {
      // Mañana se vuelve a intentar; mientras tanto el panel sigue mostrando el estado real,
      // porque se calcula de las fechas y no de lo que haya hecho esta tarea.
      this.logger.error(
        `No se pudo revisar el vencimiento de las cuentas: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Cada dos horas, los pagos de MercadoPago: el aviso suele llegar al instante, pero si no llega
   * (o el servidor no es público, como en desarrollo) el pago igual aparece en el día.
   */
  @Cron('30 */2 * * *', { timeZone: 'America/Argentina/Buenos_Aires' })
  async buscarPagos() {
    try {
      await this.cobros.conciliarTodas();
    } catch (error) {
      this.logger.error(
        `No se pudieron revisar los pagos de MercadoPago: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
