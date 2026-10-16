import { operatorName } from 'src/utils/operator-name';
import { TicketRegistration } from 'src/tickets/entities/ticket-registration.entity';
import { TicketRegistrationForDay } from 'src/tickets/entities/ticket-registration-for-day.entity';
import { recordDigital, rolloverShifts, shiftSummary } from 'src/turnos/turno-book';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Empresa } from 'src/tenancy/entities/empresa.entity';
import { ComisionesCajaDto } from './dto/comisiones-caja.dto';
import { claveComision, COMISIONES_CERO, COMISIONES_REFERENCIA, detalleComisionPago, etiquetaMedioMp, EvidenciaComisiones, resumenConComisiones } from './comisiones';
import { CuentaMercadoPago } from 'src/mercadopago/entities/cuenta-mercadopago.entity';
import { CobroMercadoPago } from 'src/mercadopago/entities/cobro-mercadopago.entity';
import { TransferenciaRecibida } from 'src/mercadopago/entities/transferencia-recibida.entity';
import { CobroTransferencia } from 'src/mercadopago/entities/cobro-transferencia.entity';
import { CreateBoxListDto } from './dto/create-box-list.dto';
import { UpdateBoxListDto } from './dto/update-box-list.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { BoxList } from './entities/box-list.entity';
import { CreateOtherPaymentDto } from './dto/create-other-payment.dto';
import { OtherPayment } from './entities/other-payment.entity';
import { CashEntry } from 'src/turnos/entities/cash-entry.entity';
import { Turno } from 'src/turnos/entities/turno.entity';
import { TicketScheduleSettings } from 'src/tickets/entities/ticket-schedule-settings.entity';
import { Movimiento } from 'src/movimientos/entities/movimiento.entity';
import { tenantContext } from 'src/tenancy/tenant-context';

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import isBetween from 'dayjs/plugin/isBetween'; 
import { UpdateOtherPaymentDto } from './dto/update-other-payment.dto';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isBetween);


@Injectable()
export class BoxListsService {

    private readonly logger = new Logger(BoxListsService.name);
  
    constructor(
      @InjectRepository(BoxList)
      private readonly boxListRepository: Repository<BoxList>,
      @InjectRepository(OtherPayment)
      private readonly otherPaymentepository: Repository<OtherPayment>,
      private readonly dataSource: DataSource,
      
    ) {}

async createBox(dto: CreateBoxListDto, manager?: EntityManager) {
  return manager ? this.applyTicketPayment(dto.date, dto.totalPrice, manager)
    : this.dataSource.transaction(tx => this.applyTicketPayment(dto.date, dto.totalPrice, tx));
}

  async getComisiones(manager = this.dataSource.manager) {
    const empresaId = tenantContext.getStore()?.empresaId;
    if (!empresaId) throw new ForbiddenException('Seleccioná una empresa.');
    const empresa = await manager.getRepository(Empresa).findOneBy({ id: empresaId });
    if (!empresa) throw new NotFoundException('Empresa no encontrada.');
    const conectada = await manager.getRepository(CuentaMercadoPago).existsBy({ empresaId, estado: 'ACTIVA' });
    // Sin configuración guardada todo arranca en 0: la tasa real depende del plazo de acreditación
    // y de las condiciones de cada cuenta, así que la referencia de Mercado Pago se carga a pedido.
    return { conectada, tasas: { ...COMISIONES_CERO, ...empresa.comisionesMp }, referencia: COMISIONES_REFERENCIA };
  }

  async configurarComisiones(dto: ComisionesCajaDto) {
    const scope = tenantContext.getStore();
    if (!scope?.empresaId || scope.role !== 'ADMIN') throw new ForbiddenException('Sólo el administrador de la empresa puede configurar comisiones.');
    if (!(await this.getComisiones()).conectada) throw new BadRequestException('Vinculá una cuenta de Mercado Pago para configurar sus comisiones.');
    await this.dataSource.getRepository(Empresa).update({ id: scope.empresaId }, {
      comisionesMp: { ...dto },
    });
    return this.getComisiones();
  }

  private async withComisiones(box: BoxList & { ticketMovements?: Movimiento[]; cobrosInquilinos?: { id: string; monto: number; solicitud?: string | null }[] }, manager = this.dataSource.manager) {
    // Las tareas internas sin empresa conservan la planilla original; nunca eligen
    // una configuración de otra cuenta. Los endpoints exigen contexto de empresa.
    if (!tenantContext.getStore()?.empresaId) return box;
    const config = await this.getComisiones(manager);
    if (!config.conectada) return box;
    const evidencia: EvidenciaComisiones = { movimientos: new Map(), abonos: new Map(), inquilinos: new Map() };
    const movs = box.ticketMovements ?? [];
    const idsQr = movs.filter(m => m.metodo === 'MERCADOPAGO').map(m => /^MercadoPago (\S+)$/.exec(m.referencia ?? '')?.[1]).filter(Boolean);
    const idsAlias = movs.filter(m => m.metodo === 'TRANSFER').map(m => /^Transferencia MercadoPago (\S+)$/.exec(m.referencia ?? '')?.[1]).filter(Boolean);
    const abonos = (box.ticketRegistrationForDays ?? []).filter(t => t.paid && t.paymentMetodo === 'MERCADOPAGO').map(t => t.id);
    const solicitudes = (box.cobrosInquilinos ?? []).map(c => c.solicitud).filter(Boolean);
    const filtros = [
      ...(idsQr.length ? [{ estado: 'ACREDITADO' as const, mpPaymentId: In(idsQr) }] : []),
      ...(abonos.length ? [{ estado: 'ACREDITADO' as const, tipo: 'ABONO' as const, registrationId: In(abonos) }] : []),
      ...(solicitudes.length ? [{ estado: 'ACREDITADO' as const, tipo: 'INQUILINO' as const, id: In(solicitudes) }] : []),
    ];
    const qr = filtros.length ? await manager.getRepository(CobroMercadoPago).find({ where: filtros, order: { acreditadoEl: 'ASC' } }) : [];
    const abonosAlias = (box.ticketRegistrationForDays ?? []).filter(t => t.paid && t.paymentMetodo === 'TRANSFER').map(t => t.id);
    const intentosAbono = abonosAlias.length ? await manager.getRepository(CobroTransferencia).findBy({ empresaId: tenantContext.getStore()!.empresaId, playaId: tenantContext.getStore()!.playaId, tipo: 'ABONO', estado: 'CONFIRMADO', registrationId: In(abonosAlias) }) : [];
    const intentosInquilino = solicitudes.length ? await manager.getRepository(CobroTransferencia).findBy({ empresaId: tenantContext.getStore()!.empresaId, playaId: tenantContext.getStore()!.playaId, tipo: 'INQUILINO', estado: 'CONFIRMADO', id: In(solicitudes) }) : [];
    const operacionesAlias = [...idsAlias, ...[...intentosAbono, ...intentosInquilino].map(i => i.operacionId).filter(Boolean)];
    const alias = operacionesAlias.length ? await manager.getRepository(TransferenciaRecibida).findBy({ empresaId: tenantContext.getStore()!.empresaId, usadaEnPlayaId: tenantContext.getStore()!.playaId, estado: 'USADA', operacionId: In(operacionesAlias) }) : [];
    for (const m of movs) {
      const pagoQr = m.metodo === 'MERCADOPAGO' && qr.find(p => p.tipo === 'HORA' && p.registrationId === m.ticketRegistration?.id && m.referencia === `MercadoPago ${p.mpPaymentId}`);
      const pagoAlias = m.metodo === 'TRANSFER' && alias.find(p => p.registrationId === m.ticketRegistration?.id && m.referencia === `Transferencia MercadoPago ${p.operacionId}`);
      if (pagoQr) evidencia.movimientos.set(m.id, claveComision('QR', pagoQr.paymentTypeId) ?? 'qrDesconocido');
      if (pagoAlias) evidencia.movimientos.set(m.id, claveComision('ALIAS', pagoAlias.paymentTypeId) ?? 'aliasDesconocido');
    }
    for (const p of qr) if (p.tipo === 'ABONO') evidencia.abonos.set(p.registrationId, claveComision('QR', p.paymentTypeId) ?? 'qrDesconocido');
    for (const i of intentosAbono) {
      const p = alias.find(t => t.cobroId === i.id);
      if (p) evidencia.abonos.set(i.registrationId, claveComision('ALIAS', p.paymentTypeId) ?? 'aliasDesconocido');
    }
    for (const c of box.cobrosInquilinos ?? []) {
      const p = qr.find(p => p.tipo === 'INQUILINO' && p.id === c.solicitud);
      if (p) evidencia.inquilinos.set(c.id, claveComision('QR', p.paymentTypeId) ?? 'qrDesconocido');
      const i = intentosInquilino.find(i => i.id === c.solicitud);
      const transferencia = i && alias.find(t => t.cobroId === i.id);
      if (transferencia) evidencia.inquilinos.set(c.id, claveComision('ALIAS', transferencia.paymentTypeId) ?? 'aliasDesconocido');
    }
    // Detalle exclusivo de la planilla: conserva el canal y el medio verificados
    // sin cambiar el método contable, el importe ni el ticket del cliente.
    for (const [filas, clasificaciones] of [
      [movs, evidencia.movimientos],
      [box.ticketRegistrationForDays ?? [], evidencia.abonos],
      [box.cobrosInquilinos ?? [], evidencia.inquilinos],
    ] as const) {
      for (const fila of filas) {
        const clasificacion = clasificaciones.get(fila.id);
        if (clasificacion) {
          const monto = 'monto' in fila ? fila.monto : fila.price;
          const porcentaje = clasificacion === 'qrDesconocido' || clasificacion === 'aliasDesconocido' ? null : config.tasas[clasificacion];
          Object.assign(fila, { medioPagoDetalle: etiquetaMedioMp(clasificacion), comisionPagoEstimada: detalleComisionPago(monto, porcentaje) });
        }
      }
    }
    return Object.assign(box, { resumenCaja: resumenConComisiones(box as BoxList, config.tasas, evidencia) });
  }

  private async recordCash(boxId: string, amount: number, manager: EntityManager, description = 'Movimiento de efectivo', turnoIdOverride?: string | null, usuarioId = tenantContext.getStore()?.userId, categoria = 'COBRO', occurredAt?: Date) {
    if (!amount) return;
    let turno = turnoIdOverride === null || (!turnoIdOverride && !usuarioId) ? null : await manager.getRepository(Turno).findOne({ where: { ...(turnoIdOverride ? { id: turnoIdOverride } : { usuarioApertura: { id: usuarioId } }), estado: 'ABIERTO', cashVersion: 2 } });
    if (turnoIdOverride && !turno) {
      const captured = await manager.getRepository(Turno).findOne({ where: { id: turnoIdOverride, cierreAutomatico: true }, relations: ['cashSession'] });
      if (captured?.cashSession?.estado === 'ABIERTO') turno = captured;
    }
    if (turnoIdOverride && !turno) throw new BadRequestException('El turno del cobro ya no está abierto.');
    const settings = await manager.getRepository(TicketScheduleSettings).findOne({ where: {} });
    if (turnoIdOverride !== null && settings?.shiftsEnabled === true && !turno && await manager.getRepository(Turno).exists({ where: { cashVersion: 2 } })) {
      throw new BadRequestException('Abrí tu turno antes de registrar efectivo en caja.');
    }
    await manager.getRepository(CashEntry).save({ boxId, amount, description, categoria, ...(occurredAt ? { createdAt: occurredAt } : {}), turnoId: turno?.id ?? null });
  }


  async applyTicketPayment(date: string, amount: number, manager: EntityManager, turnoIdOverride?: string | null, usuarioId?: string, categoria = 'COBRO', occurredAt?: Date) {
    // También protege el caso de la primera caja: bloquear una fila inexistente no alcanza.
    await manager.query('SELECT pg_advisory_xact_lock(718904)');
    await rolloverShifts(manager);
    const repository = manager.getRepository(BoxList);
    let box = await repository.findOne({ where: { date }, lock: { mode: 'pessimistic_write' } });
    if (!box) {
      const last = await repository.findOne({ where: {}, order: { boxNumber: 'DESC' } });
      box = repository.create({ date, boxNumber: (last?.boxNumber ?? 0) + 1, totalPrice: amount });
      box = await repository.save(box);
      await this.recordCash(box.id, amount, manager, 'Movimiento de efectivo', turnoIdOverride, usuarioId, categoria, occurredAt);
      return box;
    }
    if (amount !== 0) {
      await repository.increment({ id: box.id }, 'totalPrice', amount);
      box.totalPrice += amount;
      await this.recordCash(box.id, amount, manager, 'Movimiento de efectivo', turnoIdOverride, usuarioId, categoria, occurredAt);
    }
    return box;
  }

  async getAllboxes(pagination = { page: 1, limit: 25 }){
    try{

      const [data, total] = await this.boxListRepository.findAndCount({ order: { id: 'DESC' }, skip: (pagination.page - 1) * pagination.limit, take: pagination.limit });
      return { data, meta: { totalItems: total, currentPage: pagination.page, itemsPerPage: pagination.limit, totalPages: Math.ceil(total / pagination.limit) } };

    } catch (error: any) {
      this.logger.error(error.message, error.stack);
    }
  }

  private getDefaultRange() {
    const argentinaNow = dayjs().tz('America/Argentina/Buenos_Aires');
    return {
      from: argentinaNow.startOf('month').format('YYYY-MM-DD'),
      to: argentinaNow.format('YYYY-MM-DD'),
    };
  }

  async getRevenueSummary(from?: string, to?: string, groupBy: 'day' | 'month' = 'day') {
    try {
      const defaults = this.getDefaultRange();
      const rangeFrom = from ?? defaults.from;
      const rangeTo = to ?? defaults.to;

      const bucketExpr = groupBy === 'month'
        ? "TO_CHAR(box.date::date, 'YYYY-MM')"
        : "TO_CHAR(box.date::date, 'YYYY-MM-DD')";

      const rows = await this.boxListRepository
        .createQueryBuilder('box')
        .select(bucketExpr, 'bucket')
        .addSelect('SUM(box.totalPrice)', 'total')
        .where('box.date BETWEEN :from AND :to', { from: rangeFrom, to: rangeTo })
        .groupBy('bucket')
        .orderBy('bucket', 'ASC')
        .getRawMany();

      return {
        from: rangeFrom,
        to: rangeTo,
        groupBy,
        series: rows.map((r) => ({ bucket: r.bucket as string, total: Number(r.total) })),
      };
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
      throw error;
    }
  }

  async getOtherPaymentsSummary(from?: string, to?: string, groupBy: 'day' | 'month' = 'day') {
    try {
      const defaults = this.getDefaultRange();
      const rangeFrom = from ?? defaults.from;
      const rangeTo = to ?? defaults.to;

      const byTypeRows = await this.otherPaymentepository
        .createQueryBuilder('other_payment')
        .select('other_payment.type', 'type')
        .addSelect('SUM(other_payment.price)', 'total')
        .addSelect('COUNT(*)', 'count')
        .where('other_payment.dateNow BETWEEN :from AND :to', { from: rangeFrom, to: rangeTo })
        .andWhere('other_payment.type IS NOT NULL')
        .groupBy('other_payment.type')
        .getRawMany();

      const bucketExpr = groupBy === 'month'
        ? `TO_CHAR(other_payment."dateNow"::date, 'YYYY-MM')`
        : `TO_CHAR(other_payment."dateNow"::date, 'YYYY-MM-DD')`;

      const seriesRows = await this.otherPaymentepository
        .createQueryBuilder('other_payment')
        .select(bucketExpr, 'bucket')
        .addSelect("SUM(CASE WHEN other_payment.type = 'INGRESOS' THEN other_payment.price ELSE 0 END)", 'ingresos')
        .addSelect("SUM(CASE WHEN other_payment.type = 'EGRESOS' THEN other_payment.price ELSE 0 END)", 'egresos')
        .where('other_payment.dateNow BETWEEN :from AND :to', { from: rangeFrom, to: rangeTo })
        .groupBy('bucket')
        .orderBy('bucket', 'ASC')
        .getRawMany();

      return {
        from: rangeFrom,
        to: rangeTo,
        groupBy,
        byType: byTypeRows.map((r) => ({ type: r.type as string, total: Number(r.total), count: Number(r.count) })),
        series: seriesRows.map((r) => ({
          bucket: r.bucket as string,
          ingresos: Number(r.ingresos),
          egresos: Number(r.egresos),
        })),
      };
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
      throw error;
    }
  }
  async updateBox(id: string, dto: UpdateBoxListDto, manager?: EntityManager) {
    const operation = async (tx: EntityManager) => {
      await tx.query('SELECT pg_advisory_xact_lock(718904)');
      const repo = tx.getRepository(BoxList);
      const box = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!box) throw new NotFoundException('Caja no encontrada.');
      const delta = dto.totalPrice === undefined ? 0 : dto.totalPrice - box.totalPrice;
      await this.recordCash(box.id, delta, tx, 'Ajuste de efectivo');
      return repo.save(repo.merge(box, dto));
    };
    return manager ? operation(manager) : this.dataSource.transaction(operation);
  }

  // Los anticipos pertenecen al día del movimiento aunque la estadía se cierre otro día.
  private async withTicketMovements(box: BoxList, manager?: EntityManager) {
    const start = dayjs.tz(`${box.date} 00:00:00`, 'America/Argentina/Buenos_Aires');
    const ticketMovements = await (manager ?? this.dataSource.manager).getRepository(Movimiento)
      .createQueryBuilder('m')
      .innerJoinAndSelect('m.ticketRegistration', 'registration')
      .withDeleted().leftJoinAndSelect('m.usuario', 'operador')
      .where('m.fechaHora >= :start AND m.fechaHora < :end', { start: start.toDate(), end: start.add(1, 'day').toDate() })
      .orderBy('m.sequence', 'ASC')
      .getMany();
    const hourly = await (manager ?? this.dataSource.manager).getRepository(TicketRegistration).find({ where: { departureDay: box.date } });
    const daily = await (manager ?? this.dataSource.manager).getRepository(TicketRegistrationForDay).createQueryBuilder('r')
      .where('r.retired = true AND r.retiredAt >= :start AND r.retiredAt < :end', { start: start.toDate(), end: start.add(1, 'day').toDate() }).getMany();
    const salidasDelDia = [...hourly.map(r => ({ id: r.id, identificacion: r.licensePlateOriginal || r.codeBarTicket || 'Sin patente',
      hora: `${r.departureDay}T${r.departureTime}-03:00`, operador: r.exitOperatorName })),
      ...daily.map(r => ({ id: r.id, identificacion: r.vehiclePlateCustomer || r.description || 'Abono', hora: r.retiredAt, operador: r.exitOperatorName }))];
    return Object.assign(box, { salidasDelDia, ticketMovements: ticketMovements.map(({ usuario, ...m }) => ({ ...m,
      operador: usuario ? [usuario.firstName, usuario.lastName].filter(Boolean).join(' ').trim() || usuario.username : null })) });
  }

  // Cada tramo pertenece a su fecha operativa. Los turnos anteriores al corte diario
  // se ubican en su fecha de apertura, sin repetirlos en las planillas siguientes.
  private turnosDeFecha(date: string, manager: EntityManager) {
    const start = dayjs.tz(`${date} 00:00:00`, 'America/Argentina/Buenos_Aires');
    const query = manager.getRepository(Turno).createQueryBuilder('t')
      .where('(t.fechaOperativa = :date OR (t.fechaOperativa IS NULL AND t.fechaApertura >= :start AND t.fechaApertura < :end))',
        { date, start: start.toDate(), end: start.add(1, 'day').toDate() });
    const scope = tenantContext.getStore();
    // La pantalla y el PDF comparten esta consulta: el operador sólo recibe sus turnos.
    if (scope?.role === 'USER') query.andWhere('t.usuarioAperturaId = :usuarioId', { usuarioId: scope.userId });
    return query;
  }

  private async withTurnos(box: BoxList, manager?: EntityManager) {
    const repository = manager ?? this.dataSource.manager;
    const start = dayjs.tz(`${box.date} 00:00:00`, 'America/Argentina/Buenos_Aires');
    const end = start.add(1, 'day');

    const rows = await repository.getRepository(CashEntry)
      .createQueryBuilder('c')
      .select('c.turnoId', 'turnoId')
      .addSelect('COALESCE(SUM(c.amount), 0)', 'efectivoDelDia')
      .addSelect('COUNT(*)', 'movimientos')
      .addSelect('MIN(c.createdAt)', 'desde')
      .addSelect('MAX(c.createdAt)', 'hasta')
      .where('c.boxId = :boxId', { boxId: box.id })
      .groupBy('c.turnoId')
      .getRawMany<{ turnoId: string | null; efectivoDelDia: string; movimientos: string; desde: Date; hasta: Date }>();

    const turnos = await this.turnosDeFecha(box.date, repository)
      .leftJoinAndSelect('t.usuarioApertura', 'u').leftJoinAndSelect('t.caja', 'caja').leftJoinAndSelect('t.cashSession', 'session')
      .orderBy("CASE WHEN t.estado = 'ABIERTO' THEN 0 ELSE 1 END", 'ASC')
      .addOrderBy('t.fechaCierre', 'DESC', 'NULLS LAST')
      .addOrderBy('t.fechaApertura', 'DESC').addOrderBy('t.id', 'DESC').getMany();
    const turnosDelDia = await Promise.all(turnos.map(async turno => {
      const row = rows.find(r => r.turnoId === turno.id);
      return { turnoId: turno.id, turno: { ...turno, usuarioApertura: turno.usuarioApertura ? { id: turno.usuarioApertura.id, firstName: turno.usuarioApertura.firstName, lastName: turno.usuarioApertura.lastName } : null, resumen: await shiftSummary(repository, turno) },
        efectivoDelDia: Number(row?.efectivoDelDia ?? 0), movimientos: Number(row?.movimientos ?? 0),
        desde: turno.fechaApertura, hasta: turno.fechaCierre ?? new Date(),
        abarcaOtrosDias: !turno.fechaOperativa && (dayjs(turno.fechaApertura).isBefore(start) || !turno.fechaCierre || dayjs(turno.fechaCierre).isAfter(end)) };
    }));
    const unassigned = rows.find(r => !r.turnoId);
    if (unassigned && tenantContext.getStore()?.role !== 'USER') turnosDelDia.push({ turnoId: null, turno: null, efectivoDelDia: Number(unassigned.efectivoDelDia), movimientos: Number(unassigned.movimientos), desde: unassigned.desde, hasta: unassigned.hasta, abarcaOtrosDias: false });

    return Object.assign(box, { turnosDelDia });
  }

  // Los cobros a inquilinos del día, desde su cuenta corriente, para la planilla: cada medio en su
  // fila. Solo si la sección está habilitada en la playa (si no, `null`). Es el libro y no los
  // pagos por recibo porque lo que queda a favor también es plata que entró.
  //
  // Para que cuadre con el efectivo de la caja: un pago y su anulación del mismo día no se
  // muestran (se compensan); anulado otro día, el pago queda en su día y la anulación sale en el
  // suyo. Lo mismo con las devoluciones de saldo a favor. `monto`: positivo entra, negativo sale.
  private async withCobrosInquilinos(box: BoxList, manager?: EntityManager) {
    const repository = manager ?? this.dataSource.manager;
    const playaId = tenantContext.getStore()?.playaId;
    const [playa] = playaId ? await repository.query('SELECT modulos FROM playas WHERE id = $1', [playaId]) : [];
    if (!playa?.modulos?.inquilinos) return Object.assign(box, { cobrosInquilinos: null });

    const dia = String(box.date).slice(0, 10);
    const filas: any[] = await repository.query(
      `SELECT m.id, m.tipo, m.metodo, m.importe, m.numero, m.detalle, m.solicitud, m."createdAt", m."anulaId",
              c."firstName", c."lastName", trim(concat(u."firstName", ' ', u."lastName")) AS operador,
              o.tipo AS "tipoOriginal", to_char(o.fecha, 'YYYY-MM-DD') AS "fechaOriginal"
       FROM cuenta_movimientos m
       JOIN customers c ON c.id = m."customerId"
       LEFT JOIN users u ON u.id = m."usuarioId"
       LEFT JOIN cuenta_movimientos o ON o.id = m."anulaId"
       WHERE m.fecha = $1 AND m.tipo IN ('PAGO', 'DEVOLUCION', 'ANULACION')
       ORDER BY m.sequence`,
      [dia],
    );
    const anuladosEnElDia = new Set<string>(
      filas.filter((f) => f.tipo === 'ANULACION' && f.fechaOriginal === dia).map((f) => f.anulaId),
    );

    const cobrosInquilinos = filas
      .filter((f) =>
        f.tipo === 'ANULACION'
          ? (f.tipoOriginal === 'PAGO' || f.tipoOriginal === 'DEVOLUCION') && f.fechaOriginal !== dia
          : !anuladosEnElDia.has(f.id),
      )
      .map((f) => ({
        id: f.id as string,
        solicitud: f.solicitud as string | null,
        operador: f.operador || null,
        tipo: f.tipo as 'PAGO' | 'DEVOLUCION' | 'ANULACION',
        tipoOriginal: (f.tipoOriginal ?? null) as 'PAGO' | 'DEVOLUCION' | null,
        metodo: f.metodo as 'CASH' | 'TRANSFER' | 'CHECK' | 'MERCADOPAGO',
        monto: -Number(f.importe),
        numero: (f.numero ?? null) as string | null,
        cliente: `${f.lastName ?? ''} ${f.firstName ?? ''}`.trim() || 'Sin nombre',
        aFavor: f.tipo === 'PAGO' ? Number(f.detalle?.aFavor ?? 0) : 0,
        hora: f.createdAt as Date,
      }));
    return Object.assign(box, { cobrosInquilinos });
  }

  async findBoxByDate(date: string, manager?: EntityManager): Promise<BoxList | null> {
    try {
      if (!manager) return this.dataSource.transaction(m => this.findBoxByDate(date, m));
      await rolloverShifts(manager);
      const repo = manager ? manager.getRepository(BoxList) : this.boxListRepository;

      let boxList = await repo.findOne({
        where: { date: date},
        relations: [
          'ticketRegistrations',
          'ticketRegistrations.movimientos',
          'receipts',
          'receipts.customer',
          'otherPayments',
          'ticketRegistrationForDays',
          'receipts.customer.parkingRenters',
          'receipts.customer.parkingOwners',
          'receipts.customer.parkingRenters.parkingOwner.customer',
          'receipts.customer.parkingRenters.parkingOwner.customer.receipts',
          'receiptPayments',
          'receiptPayments.receipt',
          'receiptPayments.receipt.customer',
          'receiptPayments.receipt.customer.parkingRenters',
          'receiptPayments.receipt.customer.parkingOwners',
          'receiptPayments.receipt.customer.parkingRenters.parkingOwner.customer',
          'receiptPayments.receipt.customer.parkingRenters.parkingOwner.customer.receipts',
          'paymentHistoryOnAccount',
          'paymentHistoryOnAccount.receipt',
          'paymentHistoryOnAccount.receipt.customer',
          'paymentHistoryOnAccount.receipt.customer.parkingRenters',
          'paymentHistoryOnAccount.receipt.customer.parkingOwners',
          'paymentHistoryOnAccount.receipt.customer.parkingRenters.parkingOwner.customer',
        ],
      });
      
      if (!boxList && await this.turnosDeFecha(date, manager).getExists()) {
        boxList = manager ? await this.applyTicketPayment(date, 0, manager) : await this.dataSource.transaction(m => this.applyTicketPayment(date, 0, m));
      }
      if (!boxList) {
        console.warn(`No se encontró un BoxList para la fecha: ${date}`);
        return null;
      }
  
      return this.withComisiones(await this.withCobrosInquilinos(
        await this.withTurnos(await this.withTicketMovements(boxList, manager), manager),
        manager,
      ), manager);
    } catch (error: any) {
      this.logger.error(`Error buscando BoxList por fecha: ${error.message}`, error.stack);
      throw error;
    }
  }
  

  async findOne(boxListId: string) {
    try{
      const boxListWithRegistrations = await this.boxListRepository.findOne({
        where: { id: boxListId },
        relations: ['ticketRegistrations', 'ticketRegistrations.movimientos', 'receipts', 'receiptPayments', 'paymentHistoryOnAccount', 'ticketRegistrationForDays','otherPayments', 'receipts.customer.parkingRenters', 'receipts.customer.parkingOwners'],
      });
      if(!boxListWithRegistrations){
        throw new NotFoundException('Box list not found')
      }
      return this.withComisiones(await this.withCobrosInquilinos(await this.withTurnos(await this.withTicketMovements(boxListWithRegistrations))));
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  async removeBox(id: string) {
    return this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const repo = manager.getRepository(BoxList);
      const box = await repo.findOneBy({ id });
      if (!box) throw new NotFoundException('Caja no encontrada.');
      if (await manager.getRepository(CashEntry).exists({ where: { boxId: id } })) throw new BadRequestException('Una caja con movimientos de efectivo no se puede eliminar.');
      await repo.remove(box);
      return { message: 'Caja eliminada.' };
    });
  }

  // Solo lo que efectivamente queda en la caja física (efectivo) afecta el totalPrice.
  // Una transferencia no se refleja en el total, igual que los pagos de recibos por transferencia.
  private computeBoxDelta(type: string | undefined, price: number): number {
    return type === 'EGRESOS' ? -price : price;
  }

  /**
   * El turno donde queda un ingreso o gasto de «Varios». Lo normal es el de quien lo carga; si lo
   * carga alguien sin turno abierto (el administrador desde Caja), va al turno abierto de la caja:
   * la plata sale o entra de ese cajón y su arqueo la tiene que contar. Antes se rechazaba con
   * «Abrí tu turno…» y el administrador no podía registrar un gasto. Con cajas distintas abiertas
   * no se sabe de cuál sale: lo registra alguien con turno en esa caja. `undefined` deja la regla
   * de siempre (el turno propio, o ninguno si los turnos están apagados).
   */
  private async turnoParaVarios(manager: EntityManager): Promise<string | undefined> {
    await rolloverShifts(manager);
    const usuarioId = tenantContext.getStore()?.userId;
    const repo = manager.getRepository(Turno);
    if (usuarioId && await repo.exists({ where: { usuarioApertura: { id: usuarioId }, estado: 'ABIERTO' } })) return undefined;
    const abiertos = await repo.find({ where: { estado: 'ABIERTO', cashVersion: 2 }, order: { fechaApertura: 'DESC' } });
    if (!abiertos.length) return undefined;
    if (new Set(abiertos.map(t => t.cashSessionId)).size > 1)
      throw new BadRequestException('Hay más de una caja abierta: registralo desde el turno de la caja de donde sale o entra el efectivo.');
    return abiertos[0].id;
  }

  async createOtherPayment(dto: CreateOtherPaymentDto) {
    return this.dataSource.transaction(async manager => {
      const date = dayjs().tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD');
      const amount = dto.paymentMethod === 'TRANSFER' ? 0 : this.computeBoxDelta(dto.type, dto.price);
      const digital = dto.paymentMethod === 'TRANSFER' && dto.type !== 'EGRESOS';
      const turnoId = amount || digital ? await this.turnoParaVarios(manager) : undefined;
      const box = await this.applyTicketPayment(date, amount, manager, turnoId, undefined, dto.type === 'EGRESOS' ? 'GASTO' : 'INGRESO');
      const saved = await manager.getRepository(OtherPayment).save(manager.getRepository(OtherPayment).create({ ...dto, operatorName: await operatorName(manager), dateNow: date, boxList: { id: box.id } }));
      if (digital) await recordDigital(manager, dto.price, 'TRANSFER', 'Varios ' + saved.id, undefined, turnoId);
      return saved;
    });
  }

  async updateOtherPayment(id: string, dto: UpdateOtherPaymentDto) {
    return this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const repo = manager.getRepository(OtherPayment);
      const old = await repo.findOne({ where: { id }, relations: ['boxList'] });
      if (!old) throw new NotFoundException('Movimiento no encontrado.');
      const before = old.paymentMethod === 'TRANSFER' ? 0 : this.computeBoxDelta(old.type, old.price);
      const oldType = old.type;
      const digitalBefore = old.paymentMethod === 'TRANSFER' && old.type !== 'EGRESOS' ? old.price : 0;
      const updated = repo.merge(old, dto);
      const after = updated.paymentMethod === 'TRANSFER' ? 0 : this.computeBoxDelta(updated.type, updated.price);
      const date = dayjs().tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD');
      if (old.dateNow !== date) throw new BadRequestException('Los movimientos de días anteriores se corrigen con un movimiento nuevo.');
      const digitalAfter = updated.paymentMethod === 'TRANSFER' && updated.type !== 'EGRESOS' ? updated.price : 0;
      const turnoId = before || after || digitalAfter !== digitalBefore ? await this.turnoParaVarios(manager) : undefined;
      await this.applyTicketPayment(date, -before, manager, turnoId, undefined, oldType === 'EGRESOS' ? 'GASTO' : 'INGRESO');
      const box = await this.applyTicketPayment(date, after, manager, turnoId, undefined, updated.type === 'EGRESOS' ? 'GASTO' : 'INGRESO');
      if (digitalAfter !== digitalBefore) await recordDigital(manager, digitalAfter - digitalBefore, 'TRANSFER', 'Corrección varios ' + id, undefined, turnoId);
      updated.boxList = { id: box.id } as BoxList;
      return repo.save(updated);
    });
  }
  async findAllOtherPayment(pagination = { page: 1, limit: 25 }, search = '', sort = 'dateNow', direction = 'DESC') {
    try {
      const query = this.otherPaymentepository.createQueryBuilder('e').leftJoinAndSelect('e.boxList', 'box');
      if (search.trim()) query.andWhere('e.description ILIKE :search', { search: '%' + search.slice(0, 120).trim().replace(/[\\%_]/g, '\\$&') + '%' });
      const column = ['dateNow', 'description', 'price', 'type', 'paymentMethod'].includes(sort) ? sort : 'dateNow';
      const [data, total] = await query.orderBy(`e.${column}`, direction === 'ASC' ? 'ASC' : 'DESC').addOrderBy('e.id', 'DESC').skip((pagination.page - 1) * pagination.limit).take(pagination.limit).getManyAndCount();
      return { data, meta: { totalItems: total, currentPage: pagination.page, itemsPerPage: pagination.limit, totalPages: Math.ceil(total / pagination.limit) } };
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
    }
  }
  

  async removeOtherPayment(id: string) {
    return this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const repo = manager.getRepository(OtherPayment);
      const payment = await repo.findOne({ where: { id } });
      if (!payment) throw new NotFoundException('Movimiento no encontrado.');
      const date = dayjs().tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD');
      if (payment.dateNow !== date) throw new BadRequestException('Los movimientos de días anteriores se corrigen con un movimiento nuevo.');
      const efectivo = payment.paymentMethod !== 'TRANSFER';
      const digital = !efectivo && payment.type !== 'EGRESOS';
      const turnoId = efectivo || digital ? await this.turnoParaVarios(manager) : undefined;
      if (efectivo) await this.applyTicketPayment(date, -this.computeBoxDelta(payment.type, payment.price), manager, turnoId, undefined, payment.type === 'EGRESOS' ? 'GASTO' : 'INGRESO');
      else if (digital) await recordDigital(manager, -payment.price, 'TRANSFER', 'Eliminación varios ' + id, undefined, turnoId);
      await repo.remove(payment);
      return { message: 'Movimiento eliminado.' };
    });
  }

  async updateBoxByDate(date: string, totalPrice: number) {
    try {
      const boxList = await this.boxListRepository.findOne({ where: { date } });
  
      if (!boxList) {
        throw new NotFoundException(`No se encontró BoxList para la fecha ${date}`);
      }
  
      // Actualizar el totalPrice con tu método existente
      return await this.updateBox(boxList.id, { totalPrice });
    } catch (error: any) {
      this.logger.error(`❌ Error al actualizar BoxList para ${date}: ${error.message}`);
      throw error;
    }
  }
  
}
