import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CuentaMercadoPago } from './entities/cuenta-mercadopago.entity';
import { MercadoPagoService } from './mercadopago.service';
import { VERSION_CONTROL_TURNO, aceptoAlMenos } from './condiciones';
import { totalesRecibidos, totalesRegistrados } from './control-turno';
import { ControlMercadoPago, Turno } from 'src/turnos/entities/turno.entity';
import { TurnosService } from 'src/turnos/turnos.service';
import { tenantContext } from 'src/tenancy/tenant-context';
import { UserRole } from 'src/users/entities/user.entity';

const API = 'https://api.mercadopago.com';
const TIEMPO_LIMITE_MS = 12_000;
// Un turno largo de una playa con mucho movimiento: de a 100 por página.
const MAXIMO_PAGOS = 1000;

type Lectura = { ok: true; pagos: any[] } | { ok: false; error: string };

/**
 * El control de Mercado Pago de un turno: cuánto entró a la cuenta de la empresa entre la apertura y
 * el cierre, contra lo que el sistema registró por Mercado Pago y transferencias en ese horario
 * (ver control-turno.ts). Se consulta al comparar el conteo en el cierre (sin guardar) y se guarda
 * en el turno al cerrarlo. Solo con la cuenta conectada y las condiciones 2026-11-13 aceptadas.
 */
@Injectable()
export class ControlTurnoMercadoPagoService implements OnModuleInit {
  private readonly logger = new Logger(ControlTurnoMercadoPagoService.name);

  constructor(
    @InjectRepository(CuentaMercadoPago)
    private readonly cuentas: Repository<CuentaMercadoPago>,
    private readonly mercadoPago: MercadoPagoService,
    private readonly turnos: TurnosService,
    private readonly dataSource: DataSource,
  ) {}

  onModuleInit() {
    this.turnos.alCerrarTurno((turno) => this.guardar(turno));
  }

  /**
   * Para el cierre (turno abierto: hasta ahora, sin guardar) y para el historial (turno cerrado: el
   * guardado; si no hay uno correcto, la administración lo consulta con el horario del turno y queda
   * guardado). Null: no disponible.
   */
  async consultar(id: string, usuarioId: string, rol?: UserRole) {
    const turno = await this.dataSource.getRepository(Turno).findOne({
      where: { id },
      relations: ['usuarioApertura'],
    });
    if (!turno) throw new NotFoundException('Turno no encontrado.');
    if (
      turno.usuarioApertura?.id !== usuarioId &&
      !['ADMIN', 'SUPER_ADMIN'].includes(rol ?? '')
    )
      throw new ForbiddenException(
        'Solo el responsable del turno o un administrador pueden ver la caja.',
      );
    if (turno.estado === 'ABIERTO') return this.calcular(turno, new Date());
    if (turno.controlMercadoPago?.estado === 'OK') return turno.controlMercadoPago;
    // Un turno ya cerrado (uno anterior a esta función, un corte de medianoche o una consulta que
    // falló) lo consulta la administración desde el historial, con el horario de ese turno.
    if (!['ADMIN', 'SUPER_ADMIN'].includes(rol ?? ''))
      throw new ForbiddenException({
        code: 'SOLO_ADMINISTRACION',
        message: 'Solo un administrador puede consultar Mercado Pago para un turno cerrado.',
      });
    return this.guardar(turno);
  }

  /** Al cerrar: consulta el horario completo del turno y lo deja en el historial. */
  async guardar(turno: Turno) {
    if (!turno.fechaCierre) return null;
    const control = await this.calcular(turno, turno.fechaCierre);
    if (!control) return null;
    await this.dataSource
      .getRepository(Turno)
      .update(turno.id, { controlMercadoPago: control });
    turno.controlMercadoPago = control;
    return control;
  }

  private async calcular(
    turno: Turno,
    hasta: Date,
  ): Promise<ControlMercadoPago | null> {
    const empresaId = tenantContext.getStore()?.empresaId;
    if (!empresaId) return null;
    const cuenta = await this.cuentas.findOneBy({ empresaId });
    if (
      !cuenta ||
      cuenta.estado !== 'ACTIVA' ||
      !cuenta.accessToken ||
      !aceptoAlMenos(cuenta.condicionesVersion, VERSION_CONTROL_TURNO)
    )
      return null;
    const desde = new Date(turno.fechaApertura);
    const base = {
      consultadoEl: new Date().toISOString(),
      desde: desde.toISOString(),
      hasta: hasta.toISOString(),
    };
    const lectura = await this.buscar(cuenta, desde, hasta);
    if (lectura.ok === false)
      return { estado: 'ERROR', ...base, message: lectura.error };
    const mercadoPago = totalesRecibidos(lectura.pagos, cuenta.mpUserId, desde, hasta);
    // El mismo criterio que el resumen del turno, pero por horario y de toda la playa: es lo que
    // se compara con la cuenta, que no sabe de turnos ni de operadores.
    const filas = await this.dataSource.query(
      `SELECT medio, SUM(amount) AS total FROM (
        SELECT CASE WHEN metodo = 'MERCADOPAGO' THEN 'QR'
          WHEN referencia LIKE 'Transferencia MercadoPago %' THEN 'ALIAS' ELSE metodo::text END AS medio, monto AS amount
          FROM movimientos
          WHERE "fechaHora" >= $1 AND "fechaHora" <= $2 AND tipo NOT IN ('CORTESIA', 'DESCUENTO') AND metodo <> 'CASH'
        UNION ALL SELECT medio, amount FROM turno_payments WHERE "createdAt" >= $1 AND "createdAt" <= $2
      ) p GROUP BY medio`,
      [desde, hasta],
    );
    const sistema = totalesRegistrados(filas);
    const [{ playas }] = await this.dataSource.query(
      'SELECT COUNT(*)::int AS playas FROM playas WHERE "empresaId" = $1',
      [empresaId],
    );
    return {
      estado: 'OK',
      ...base,
      mercadoPago,
      sistema,
      diferencia: mercadoPago.total - sistema.total,
      variasPlayas: Number(playas) > 1,
    };
  }

  /**
   * Los pagos de la cuenta entre `desde` y `hasta`, de a 100. Una lista incompleta es un error: un
   * total parcial diría que falta plata que no falta.
   */
  private async buscar(
    cuenta: CuentaMercadoPago,
    desde: Date,
    hasta: Date,
  ): Promise<Lectura> {
    let token: string;
    try {
      token = await this.mercadoPago.tokenDeEmpresa(cuenta.empresaId);
    } catch {
      return { ok: false, error: 'No se pudo usar la cuenta de Mercado Pago.' };
    }
    const pagos: any[] = [];
    for (let offset = 0; offset < MAXIMO_PAGOS; offset += 100) {
      const busqueda = new URLSearchParams({
        sort: 'date_created',
        criteria: 'asc',
        range: 'date_created',
        // Margen para los relojes; el filtro exacto lo hace totalesRecibidos. Un QR se crea antes
        // de pagarse: se busca desde un rato antes de abrir el turno.
        begin_date: new Date(desde.getTime() - 30 * 60_000).toISOString(),
        end_date: new Date(hasta.getTime() + 60_000).toISOString(),
        limit: '100',
        offset: String(offset),
      });
      let respuesta: Response;
      try {
        respuesta = await fetch(`${API}/v1/payments/search?${busqueda}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
        });
      } catch {
        return { ok: false, error: 'No se pudo consultar Mercado Pago.' };
      }
      if (!respuesta.ok) {
        // El cuerpo no se loguea: puede traer datos de pagos.
        await respuesta.body?.cancel();
        this.logger.warn(
          `MercadoPago respondió ${respuesta.status} a la búsqueda de pagos de la cuenta ${cuenta.mpUserId}.`,
        );
        return {
          ok: false,
          error: `No se pudo consultar Mercado Pago (respondió ${respuesta.status}).`,
        };
      }
      const datos = (await respuesta.json()) as {
        results?: any[];
        paging?: { total?: number };
      };
      const pagina = datos.results ?? [];
      pagos.push(...pagina);
      const total = datos.paging?.total ?? pagos.length;
      if (pagos.length >= total || pagina.length === 0) return { ok: true, pagos };
    }
    return {
      ok: false,
      error: 'Entraron demasiados pagos en el horario del turno para sumarlos todos.',
    };
  }
}
