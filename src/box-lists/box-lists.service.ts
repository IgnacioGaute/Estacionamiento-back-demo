import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreateBoxListDto } from './dto/create-box-list.dto';
import { UpdateBoxListDto } from './dto/update-box-list.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, EntityManager, In, Repository } from 'typeorm';
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

  private async recordCash(boxId: string, amount: number, manager: EntityManager, description = 'Movimiento de efectivo') {
    if (!amount) return;
    const turno = await manager.getRepository(Turno).findOne({ where: { estado: 'ABIERTO', cashVersion: 2 } });
    const settings = await manager.getRepository(TicketScheduleSettings).findOne({ where: {} });
    if (settings?.shiftsEnabled !== false && !turno && await manager.getRepository(Turno).exists({ where: { cashVersion: 2 } })) {
      throw new BadRequestException('Abrí el siguiente turno antes de registrar efectivo en caja.');
    }
    await manager.getRepository(CashEntry).save({ boxId, amount, description, turnoId: turno?.id ?? null });
  }


  async applyTicketPayment(date: string, amount: number, manager: EntityManager) {
    // También protege el caso de la primera caja: bloquear una fila inexistente no alcanza.
    await manager.query('SELECT pg_advisory_xact_lock(718904)');
    const repository = manager.getRepository(BoxList);
    let box = await repository.findOne({ where: { date }, lock: { mode: 'pessimistic_write' } });
    if (!box) {
      const last = await repository.findOne({ where: {}, order: { boxNumber: 'DESC' } });
      box = repository.create({ date, boxNumber: (last?.boxNumber ?? 0) + 1, totalPrice: amount });
      box = await repository.save(box);
      await this.recordCash(box.id, amount, manager);
      return box;
    }
    if (amount !== 0) {
      await repository.increment({ id: box.id }, 'totalPrice', amount);
      box.totalPrice += amount;
      await this.recordCash(box.id, amount, manager);
    }
    return box;
  }

  async getAllboxes(){
    try{

      const boxes = await this.boxListRepository.find()
      return boxes

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
      .where('m.fechaHora >= :start AND m.fechaHora < :end', { start: start.toDate(), end: start.add(1, 'day').toDate() })
      .orderBy('m.sequence', 'ASC')
      .getMany();
    return Object.assign(box, { ticketMovements });
  }

  // Un turno no entra en un día: uno de 24 h cruza la medianoche y aparece en dos planillas, y
  // un día puede tener varios turnos. La relación es de muchos a muchos y ya la expresa
  // cash_entries, que lleva boxId y turnoId en cada fila. Lo que pertenece a este día es la
  // porción de efectivo que cayó en él — el arqueo (contado, diferencia, retiro) es del turno
  // entero y se mira en su historial, no acá, o quedaría mal repartido entre dos días.
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

    const ids = rows.map((r) => r.turnoId).filter((id): id is string => !!id);
    const turnos = ids.length
      ? await repository.getRepository(Turno).find({ where: { id: In(ids) }, relations: ['usuarioApertura', 'usuarioCierre'] })
      : [];
    const porId = new Map(turnos.map((t) => [t.id, t]));

    const turnosDelDia = rows
      .map((row) => {
        // turno null = efectivo registrado antes de adoptar la caja por turnos. Se muestra
        // aparte para que la suma de los turnos siga cuadrando con el total del día.
        const turno = row.turnoId ? porId.get(row.turnoId) ?? null : null;
        const abrioAntes = !!turno && dayjs(turno.fechaApertura).isBefore(start);
        const cierraDespues = !!turno && (!turno.fechaCierre || dayjs(turno.fechaCierre).isAfter(end));
        return {
          turnoId: row.turnoId,
          turno: turno && tenantContext.getStore()?.role === 'USER' ? {
            id: turno.id, nombre: turno.nombre, estado: turno.estado,
            fechaApertura: turno.fechaApertura, fechaCierre: turno.fechaCierre,
            usuarioApertura: turno.usuarioApertura ? {
              firstName: turno.usuarioApertura.firstName, lastName: turno.usuarioApertura.lastName,
            } : null,
          } : turno,
          efectivoDelDia: Number(row.efectivoDelDia),
          movimientos: Number(row.movimientos),
          desde: row.desde,
          hasta: row.hasta,
          // Avisa a la interfaz que el arqueo de ese turno no le corresponde sólo a este día.
          abarcaOtrosDias: abrioAntes || cierraDespues,
        };
      })
      .sort((a, b) => {
        if (!a.turnoId) return 1;
        if (!b.turnoId) return -1;
        return new Date(a.desde).getTime() - new Date(b.desde).getTime();
      });

    return Object.assign(box, { turnosDelDia });
  }

  async findBoxByDate(date: string, manager?: EntityManager): Promise<BoxList | null> {
    try {
      if (manager) await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const repo = manager ? manager.getRepository(BoxList) : this.boxListRepository;

      const boxList = await repo.findOne({
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
      
      if (!boxList) {
        console.warn(`No se encontró un BoxList para la fecha: ${date}`);
        return null;
      }
  
      return this.withTurnos(await this.withTicketMovements(boxList, manager), manager);
    } catch (error: any) {
      this.logger.error(`Error buscando BoxList por fecha: ${error.message}`, error.stack);
      throw error;
    }
  }
  

  async findOne(boxListId: string) {
    try{
      const boxListWithRegistrations = await this.boxListRepository.findOne({
        where: { id: boxListId },
        relations: ['ticketRegistrations', 'ticketRegistrations.movimientos', 'receipts', 'ticketRegistrationForDays','otherPayments', 'receipts.customer.parkingRenters', 'receipts.customer.parkingOwners'],
      });
      if(!boxListWithRegistrations){
        throw new NotFoundException('Box list not found')
      }
      return this.withTurnos(await this.withTicketMovements(boxListWithRegistrations));
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

  async createOtherPayment(dto: CreateOtherPaymentDto) {
    return this.dataSource.transaction(async manager => {
      const date = dayjs().tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD');
      const amount = dto.paymentMethod === 'TRANSFER' ? 0 : this.computeBoxDelta(dto.type, dto.price);
      const box = await this.applyTicketPayment(date, amount, manager);
      return manager.getRepository(OtherPayment).save(manager.getRepository(OtherPayment).create({ ...dto, dateNow: date, boxList: { id: box.id } }));
    });
  }

  async updateOtherPayment(id: string, dto: UpdateOtherPaymentDto) {
    return this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const repo = manager.getRepository(OtherPayment);
      const old = await repo.findOne({ where: { id }, relations: ['boxList'] });
      if (!old) throw new NotFoundException('Movimiento no encontrado.');
      const before = old.paymentMethod === 'TRANSFER' ? 0 : this.computeBoxDelta(old.type, old.price);
      const updated = repo.merge(old, dto);
      const after = updated.paymentMethod === 'TRANSFER' ? 0 : this.computeBoxDelta(updated.type, updated.price);
      const date = dayjs().tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD');
      if (old.dateNow !== date) throw new BadRequestException('Los movimientos de días anteriores se corrigen con un movimiento nuevo.');
      const box = await this.applyTicketPayment(date, after - before, manager);
      updated.boxList = { id: box.id } as BoxList;
      return repo.save(updated);
    });
  }
  async findAllOtherPayment() {
    try {
      const expenses = await this.otherPaymentepository.find({
        relations: ['boxList'],
        order: {
          dateNow: 'DESC',  // 👈 Cambiado a descendente
        },
      });
  
      return expenses;
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
      if (payment.paymentMethod !== 'TRANSFER') await this.applyTicketPayment(date, -this.computeBoxDelta(payment.type, payment.price), manager);
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
