import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { EntityManager, IsNull } from 'typeorm';
import dayjs from 'dayjs';
import { operationContext } from 'src/common/operation-context';
import { tenantContext } from 'src/tenancy/tenant-context';
import { esGratuita } from 'src/tenancy/modalidad';
import { publishAutomaticNote } from 'src/notes/automatic-note';
import { TurnosService } from 'src/turnos/turnos.service';
import { Turno } from 'src/turnos/entities/turno.entity';
import { CashSession } from 'src/turnos/entities/cash-session.entity';
import { UserRole } from 'src/users/entities/user.entity';
import { offlineShift } from 'src/turnos/turno-book';
import { OpenTurnoDto } from 'src/turnos/dto/open-turno.dto';
import { CloseTurnoDto } from 'src/turnos/dto/close-turno.dto';
import { CashSessionMovementDto } from 'src/turnos/dto/caja.dto';
import { TicketsService } from './tickets.service';
import { TicketRegistration } from './entities/ticket-registration.entity';
import { TicketRegistrationForDay } from './entities/ticket-registration-for-day.entity';
import { Ticket } from './entities/ticket.entity';
import { TicketPrice } from './entities/ticket-price.entity';
import { OfflineSession } from './entities/offline-session.entity';
import { OfflineOperationDto } from './dto/offline.dto';
import { CreateRegistrationByPlateDto } from './dto/create-registration-by-plate.dto';
import { CloseRegistrationDto } from './dto/close-registration.dto';
import { SalidaAnteriorDto } from './dto/salida-anterior.dto';
import { AdvancePaymentTicketRegistrationDto } from './dto/advance-payment-ticket-registration.dto';
import { DiscountRegistrationDto } from './dto/discount-registration.dto';
import { CorregirDatosEstadiaDto } from './dto/corregir-datos-estadia.dto';
import { CorregirEntradaDto } from './dto/corregir-entrada.dto';
import { PagoParcialDto } from './dto/pago-parcial.dto';
import { TicketScheduleSettings } from './entities/ticket-schedule-settings.entity';
import { BoxListsService } from 'src/box-lists/box-lists.service';
import { CreateOtherPaymentDto } from 'src/box-lists/dto/create-other-payment.dto';
import { CreateTicketRegistrationForDayDto, UpdateTicketStatusDto } from './dto/create-ticket-registration-for-day.dto';

export const offlineVehicleState = (v: any) => JSON.stringify([v.plate, v.vehicleType, v.entry, v.collected ?? 0, v.discount ?? 0, !!v.departed]);

@Injectable()
export class OfflineActionsService {
  constructor(private readonly tickets: TicketsService, private readonly turnos: TurnosService, private readonly boxes: BoxListsService) {}

  async extras(manager: EntityManager, gratuita: boolean) {
    const scope = tenantContext.getStore()!;
    const cash = gratuita ? null : await operationContext.run({ manager, at: new Date(), resourceId: '', shiftId: null, snapshot: {}, afterCommit: [] }, () => this.turnos.getCashContext(scope.userId));
    const settings = await manager.getRepository(TicketScheduleSettings).findOne({ where: {} });
    return {
      operationVersion: 3, role: scope.role, cash,
      salary: !gratuita && settings?.sueldoAutomatico ? settings.sueldosPorUsuario?.find(s => s.usuarioId === scope.userId)?.importe ?? 0 : 0,
      cards: (await manager.getRepository(Ticket).find()).map(t => ({ id: t.id, codeBar: t.codeBar, vehicleType: t.vehicleType })),
      passPrices: gratuita ? [] : await manager.getRepository(TicketPrice).find(),
      passes: gratuita ? [] : await manager.getRepository(TicketRegistrationForDay).find({ where: [{ retired: false }, { retired: IsNull() }] }),
    };
  }

  private async dto<T extends object>(type: new () => T, data: Record<string, any>): Promise<T> {
    const dto = plainToInstance(type, data);
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
    if (errors.length) throw new BadRequestException({ code: 'OFFLINE_DATOS_INVALIDOS', message: 'Revisá los datos de la operación pendiente.', details: errors.map(e => ({ field: e.property, errors: e.constraints })) });
    return dto;
  }

  async execute(manager: EntityManager, session: OfflineSession, op: OfflineOperationDto, afterCommit: (() => void)[]) {
    if (!op.action || !op.data || session.snapshot.operationVersion !== 3) throw new BadRequestException('Actualizá la copia sin conexión antes de usar estas opciones.');
    const scope = tenantContext.getStore()!;
    const action = op.action, data = op.data, at = new Date(op.occurredAt);
    if (['DELETE', 'CASH_MOVEMENT'].includes(action) && !['ADMIN', 'SUPER_ADMIN'].includes(scope.role)) throw new ForbiddenException('Esta operación requiere un administrador.');
    const creating = ['PLATE_ENTRY', 'CARD_ENTRY', 'PASS_ENTRY', 'SHIFT_OPEN'].includes(action);
    const cashAction = action.startsWith('SHIFT_') || ['CASH_MOVEMENT','BOX_MOVEMENT'].includes(action);
    let registrationFree = false;
    let shiftId = op.shiftId ?? null;
    const ownCreated = (id: string, kind: string) => Object.values(session.processed).some(p => p.registrationId === id && p.action === kind);
    if (creating) {
      const entity = action === 'SHIFT_OPEN' ? Turno : action === 'PASS_ENTRY' ? TicketRegistrationForDay : TicketRegistration;
      if (await manager.getRepository(entity).existsBy({ id: op.registrationId })) throw new ConflictException('Ese identificador ya está en uso. No se reemplazó el registro existente.');
    }
    if (!shiftId && session.snapshot.shift?.id && !ownCreated(session.snapshot.shift.id, 'SHIFT_CLOSE')) throw new ConflictException('La operación perdió la referencia al turno capturado.');
    const settings = await manager.getRepository(TicketScheduleSettings).findOne({ where: {} });
    if (!!settings?.shiftsEnabled !== !!session.snapshot.shiftsEnabled && session.snapshot.modalidad !== 'GRATUITO') throw new ConflictException('Cambió la configuración de turnos. Conservá el pendiente para revisión.');
    if (shiftId && shiftId !== session.snapshot.shift?.id && !ownCreated(shiftId, 'SHIFT_OPEN')) throw new ForbiddenException('El turno no pertenece a esta contingencia.');
    if (shiftId) shiftId = (await offlineShift(manager, shiftId, scope.userId!, at)).id;
    if (cashAction && session.snapshot.modalidad === 'GRATUITO') throw new BadRequestException('La modalidad gratuita no tiene operaciones de caja.');
    if (!creating && !cashAction) {
      if (action === 'PASS_UPDATE') {
        if (!session.snapshot.passes.some(p => p.id === op.registrationId) && !ownCreated(op.registrationId, 'PASS_ENTRY')) throw new ForbiddenException();
        const pass = await manager.getRepository(TicketRegistrationForDay).findOne({ where: { id: op.registrationId }, lock: { mode: 'pessimistic_write' } });
        if (!pass || op.expectedState !== JSON.stringify([pass.price, !!pass.paid, !!pass.retired, pass.paymentMetodo ?? null])) throw new ConflictException('La estadía cambió en otro equipo. Conservá la operación para revisión.');
      } else {
        if (!session.snapshot.vehicles.some(v => v.id === op.registrationId) && !Object.values(session.processed).some(p => p.registrationId === op.registrationId && (!p.action || ['PLATE_ENTRY', 'CARD_ENTRY'].includes(p.action)))) throw new ForbiddenException();
        const r = await manager.getRepository(TicketRegistration).findOne({ where: { id: op.registrationId }, lock: { mode: 'pessimistic_write' } });
        if (!r || r.departureTime) throw new ConflictException('La estadía ya se cerró o eliminó en otro equipo. La operación sigue pendiente.');
        const related = await manager.getRepository(TicketRegistration).findOne({ where: { id: r.id }, relations: ['ticket'] });
        registrationFree = esGratuita(r.modalidad);
        const [discount] = await manager.query('SELECT COALESCE(SUM(monto),0) AS total FROM movimientos WHERE "ticketRegistrationId"=$1 AND tipo=\'DESCUENTO\'', [r.id]);
        const actual = offlineVehicleState({ plate: r.licensePlateOriginal || r.codeBarTicket || related?.ticket?.codeBar || r.lastNameCustomer || 'Sin patente', vehicleType: r.vehicleType || related?.ticket?.vehicleType, entry: dayjs.tz(`${r.entryDay} ${r.entryTime}`, 'America/Argentina/Buenos_Aires').toISOString(), collected: registrationFree ? 0 : await this.tickets.collectedAmount(r, manager), discount: Number(discount.total) });
        if (actual !== op.expectedState) throw new ConflictException('La estadía cambió en otro equipo. Conservá la operación pendiente para revisión.');
        const [pending] = await manager.query(`SELECT EXISTS(SELECT 1 FROM cobros_mercadopago WHERE "registrationId"=$1 AND estado='PENDIENTE' UNION ALL SELECT 1 FROM cobros_transferencia WHERE "registrationId"=$1 AND estado IN ('ESPERANDO','REVISION')) AS present`, [r.id]);
        if (pending.present) throw new ConflictException('Hay un pago por internet en curso. Revisalo antes de sincronizar este cobro.');
      }
    }
    // No insertar una apertura o un arqueo por delante de hechos que otro equipo ya asentó.
    if (action === 'SHIFT_OPEN') {
      if (!op.cashSessionId || !session.snapshot.cash?.cajas.some(c => c.id === data.cajaId)) throw new BadRequestException('Elegí una caja de la copia guardada.');
      if (await manager.getRepository(CashSession).existsBy({ id: op.cashSessionId })) throw new ConflictException('El identificador de la caja ya está en uso.');
      const [later] = await manager.query('SELECT EXISTS(SELECT 1 FROM turnos WHERE "cajaId"=$1 AND ("fechaApertura">$2 OR "fechaCierre">$2)) AS present', [data.cajaId, at]);
      if (later.present) throw new ConflictException('La caja tuvo otros turnos después de esta apertura. Revisá el pendiente.');
    }
    if (action === 'SHIFT_CLOSE') {
      if (!shiftId || op.registrationId !== op.shiftId) throw new ForbiddenException('Sólo podés cerrar tu turno guardado.');
      const shift = await manager.getRepository(Turno).findOneBy({ id: shiftId });
      if (!shift || shift.cierreAutomatico) throw new ConflictException('El turno tuvo un corte posterior. Conservá el cierre para revisar el arqueo.');
      const [later] = await manager.query(`SELECT EXISTS(SELECT 1 FROM cash_entries e JOIN turnos t ON t.id=e."turnoId" WHERE t."cashSessionId"=$1 AND e."createdAt">$2 UNION ALL SELECT 1 FROM cash_session_movements WHERE "sesionId"=$1 AND "createdAt">$2) AS present`, [shift.cashSessionId, at]);
      if (later.present) throw new ConflictException('La caja recibió movimientos posteriores al arqueo. El cierre sigue pendiente para revisión.');
    }
    await operationContext.run({ manager, at, resourceId: op.registrationId, cashSessionId: op.cashSessionId, shiftId, snapshot: session.snapshot, afterCommit }, async () => {
      switch (action) {
        // Sin conexión no hay escáner de patentes (la lectura necesita internet): todo es a mano.
        case 'PLATE_ENTRY': await this.tickets.createRegistrationByPlate(await this.dto(CreateRegistrationByPlateDto, { ...data, origen: 'MANUAL' }), scope.userId!); break;
        case 'CARD_ENTRY': {
          if (Object.keys(data).some(k => k !== 'ticketId') || !session.snapshot.cards.some(c => c.id === data.ticketId)) throw new BadRequestException('Tarjeta no disponible en la copia guardada.');
          const result = await this.tickets.createRegistration(data.ticketId, scope.userId!);
          if (result.requiresClose) throw new ConflictException('La tarjeta ya tiene una estadía activa.');
          break;
        }
        case 'CLOSE':
          await this.tickets.marcarOrigenSalida(op.registrationId, 'MANUAL');
          if (registrationFree) {
            if (Object.keys(data).length) throw new BadRequestException('La salida gratuita no admite cobros.');
            await this.tickets.registrarSalidaGratuita(op.registrationId, scope.userId!);
          } else if (data.salidaEn) await this.tickets.registrarSalidaAnterior(op.registrationId, await this.dto(SalidaAnteriorDto, data), scope.userId!);
          else await this.tickets.closeRegistrationByPlate(op.registrationId, await this.dto(CloseRegistrationDto, data), scope.userId!);
          break;
        case 'ADVANCE': await this.tickets.addAdvancePayment(op.registrationId, await this.dto(AdvancePaymentTicketRegistrationDto, data), scope.userId!); break;
        case 'DISCOUNT': await this.tickets.discountRegistration(op.registrationId, await this.dto(DiscountRegistrationDto, data), scope.userId!); break;
        case 'PARTIAL_CASH': {
          const dto = await this.dto(PagoParcialDto, data);
          await this.tickets.cobrarParteEnEfectivo(op.registrationId, dto, scope.userId!); break;
        }
        case 'EDIT': await this.tickets.corregirDatosEstadia(op.registrationId, await this.dto(CorregirDatosEstadiaDto, data), scope.userId!); break;
        case 'EDIT_ENTRY': await this.tickets.corregirEntradaOlvidada(op.registrationId, (await this.dto(CorregirEntradaDto, data)).entrada, scope.userId!); break;
        case 'DELETE': if (Object.keys(data).length) throw new BadRequestException(); await this.tickets.eliminarEstadiaPorError(op.registrationId); break;
        case 'PASS_ENTRY': {
          if (session.snapshot.modalidad === 'GRATUITO') throw new BadRequestException('La modalidad gratuita no tiene estadías por día, semana o mes.');
          const dto = await this.dto(CreateTicketRegistrationForDayDto, data);
          const units = [dto.days, dto.weeks, dto.months].filter(v => v !== undefined);
          if (!units.length || units.some(v => !Number.isInteger(v) || v < 0 || v > 365) || !units.some(v => v > 0) || dto.retired) throw new BadRequestException('Indicá una duración válida para la estadía.');
          await this.tickets.createRegistrationForDay(dto, scope.userId!); break;
        }
        case 'PASS_UPDATE': await this.tickets.updateTicketStatus(op.registrationId, await this.dto(UpdateTicketStatusDto, data), scope.userId!); break;
        case 'SHIFT_OPEN': await this.turnos.open(scope.userId!, await this.dto(OpenTurnoDto, data)); break;
        case 'SHIFT_CLOSE': await this.turnos.close(shiftId!, scope.userId!, await this.dto(CloseTurnoDto, data), scope.role as UserRole); break;
        case 'CASH_MOVEMENT':
          if (!session.snapshot.cash?.cajas.some(c => c.session?.id === op.registrationId)) {
            const ids = Object.values(session.processed).filter(p => p.action === 'SHIFT_OPEN').map(p => p.registrationId);
            const own = ids.length ? await manager.getRepository(Turno).findOneBy({ id: op.shiftId ?? '', cashSessionId: op.registrationId, usuarioApertura: { id: scope.userId! } }) : null;
            if (!own || !ids.includes(own.id)) throw new ForbiddenException();
          }
          await this.turnos.addCashMovement(op.registrationId, scope.userId!, await this.dto(CashSessionMovementDto, data), scope.role as UserRole); break;
        case 'BOX_MOVEMENT': await this.boxes.createOtherPayment(await this.dto(CreateOtherPaymentDto, data)); break;
      }
      const names = { EDIT: 'Corrección de datos', EDIT_ENTRY: 'Corrección de hora de ingreso', DELETE: 'Eliminación de ingreso por error', SHIFT_CLOSE: 'Cierre de turno' };
      if (names[action]) await publishAutomaticNote(manager, { sourceKey: `offline:${op.id}`, origin: 'Operación sin conexión', sourceType: cashAction ? 'TURNO' : 'TICKET', sourceId: op.registrationId, usuarioId: scope.userId, description: `${names[action]} · ${op.occurredAt}`, context: `Dispositivo ${session.deviceId}` });
    });
    return { id: op.registrationId };
  }
}
