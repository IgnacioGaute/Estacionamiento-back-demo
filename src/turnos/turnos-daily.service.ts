import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { tenantContext } from 'src/tenancy/tenant-context';
import { rolloverShifts, SHIFT_TZ } from './turno-book';

@Injectable()
export class TurnosDailyService {
  private readonly logger = new Logger(TurnosDailyService.name);
  constructor(private readonly ds: DataSource) {}
  // Cada minuto permite recuperar el corte si el proceso reinició después de medianoche.
  // La fecha efectiva del cierre siempre es 00:00, no la hora en que ejecutó el cron.
  @Cron('0 * * * * *', { timeZone: SHIFT_TZ })
  async rollover() {
    const playas = await this.ds.query(`SELECT DISTINCT p.id, p."empresaId" FROM playas p
      JOIN turnos t ON t."playaId"=p.id WHERE t.estado='ABIERTO' AND t."cashSessionId" IS NOT NULL`);
    for (const playa of playas) {
      try {
        await tenantContext.run({ playaId: playa.id, empresaId: playa.empresaId, userId: '', role: 'ADMIN' },
          () => this.ds.transaction(m => rolloverShifts(m)));
      } catch (e) { this.logger.error(`No se pudo cortar los turnos de ${playa.id}: ${e.message}`); }
    }
  }
}
