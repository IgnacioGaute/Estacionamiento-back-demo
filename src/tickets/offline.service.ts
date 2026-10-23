import { offlineShift, rolloverShifts, refreshAutomaticCuts } from 'src/turnos/turno-book';
import { Injectable, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource, In, IsNull, MoreThanOrEqual } from 'typeorm';
import { createHash } from 'crypto';
import dayjs from 'dayjs';
import { tenantContext } from 'src/tenancy/tenant-context';
import { esGratuita, leerModalidad } from 'src/tenancy/modalidad';
import { OfflineSession } from './entities/offline-session.entity';
import { TicketRegistration } from './entities/ticket-registration.entity';
import { TicketRegistrationForDay } from './entities/ticket-registration-for-day.entity';
import { ParkingReceipt } from './entities/parking-receipt.entity';
import { TicketScheduleSettings } from './entities/ticket-schedule-settings.entity';
import { TicketPriceBracket } from './entities/ticket-price-bracket.entity';
import { VehicleTypeEntity } from './entities/vehicle-type.entity';
import { TicketsService } from './tickets.service';
import { calculateStayPrice, assertPricingCoverage } from './pricing/stay-pricing';
import { PricingSnapshot } from './pricing/pricing.types';
import { BoxListsService } from 'src/box-lists/box-lists.service';
import { MovimientosService } from 'src/movimientos/movimientos.service';
import { TicketGateway } from './register-gateway';
import { OfflineOperationDto, OfflineFinishDto } from './dto/offline.dto';
import { Playa } from 'src/tenancy/entities/playa.entity';
import { User } from 'src/users/entities/user.entity';
import { Turno } from 'src/turnos/entities/turno.entity';
import { offlineSnapshotFingerprint } from './offline-snapshot';
import { OfflineActionsService } from './offline-actions.service';
const TZ = 'America/Argentina/Buenos_Aires';
@Injectable()
export class OfflineService {
  constructor(private readonly ds: DataSource, private readonly tickets: TicketsService, private readonly boxes: BoxListsService, private readonly movements: MovimientosService, private readonly gateway: TicketGateway, private readonly actions: OfflineActionsService) {}
  private scope() { const s = tenantContext.getStore(); if (!s?.userId || !s.playaId || !['USER', 'ADMIN', 'SUPER_ADMIN'].includes(s.role)) throw new ForbiddenException(); return s; }
  async prepare(deviceId: string, refresh = false, knownSessionId?: string) {
    const scope = this.scope();
    return this.ds.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718903)');
      await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const modalidad = await leerModalidad(manager, scope.playaId);
      const gratuita = esGratuita(modalidad);
      if (!gratuita) await rolloverShifts(manager);
      const schedule = await this.tickets.getSchedule(manager);
      const shift = !gratuita && schedule.shiftsEnabled
        ? await manager.getRepository(Turno).findOne({ where: { usuarioApertura: { id: scope.userId }, estado: 'ABIERTO', cashVersion: 2 } })
        : null;
      const repo = manager.getRepository(OfflineSession);
      const active = await repo.findOne({ where: { playaId: scope.playaId, userId: scope.userId, deviceId, active: true }, order: { createdAt: 'DESC' } });
      if (active && !refresh && (active.snapshot.modalidad ?? 'CON_COBRO') === modalidad) {
        return { ...active.snapshot, sessionId: active.id, processedIds: Object.keys(active.processed) };
      }
      const now = new Date();
      const pricing: PricingSnapshot | null = gratuita ? null : { version: 1, capturedAt: now.toISOString(), schedule: { ...schedule, pricingDayTypeBasis: schedule.pricingDayTypeBasis ?? 'EXIT' }, brackets: await manager.getRepository(TicketPriceBracket).find() };
      const types = await manager.getRepository(VehicleTypeEntity).find({ where: { enabled: true } });
      const operator = await manager.getRepository(User).findOne({ where: { id: scope.userId }, withDeleted: true });
      const operatorName = operator ? (`${operator.firstName} ${operator.lastName}`.trim() || operator.username) : 'Operador no disponible';
      const vehicles = [];
      for (const r of await manager.getRepository(TicketRegistration).find({ where: { playaId: scope.playaId, departureTime: IsNull() }, relations: ['ticket'] })) {
        const [discount] = await manager.query('SELECT COALESCE(SUM(monto),0) AS total FROM movimientos WHERE "ticketRegistrationId"=$1 AND tipo=\'DESCUENTO\'', [r.id]);
        // Los registros anteriores a los snapshots usan la tarifa vigente descargada, igual
        // que el cierre normal. El replay fija esa copia para no tomar precios nuevos.
        const vehiclePricing = r.pricingSnapshot ?? pricing;
        vehicles.push({ id: r.id, modalidad: r.modalidad, plate: r.licensePlateOriginal || r.codeBarTicket || r.ticket?.codeBar || r.lastNameCustomer || 'Sin patente', vehicleType: r.vehicleType || r.ticket?.vehicleType, entry: dayjs.tz(`${r.entryDay} ${r.entryTime}`, TZ).toISOString(), pricing: vehiclePricing, collected: esGratuita(r.modalidad) ? 0 : await this.tickets.collectedAmount(r, manager), discount: Number(discount.total), entryMode: r.entryMode, noPlate: r.noPlate, lastNameCustomer: r.lastNameCustomer, phoneCustomer: r.phoneCustomer, casilleroNumber: r.casilleroNumber, expectedUptoMinutes: r.expectedUptoMinutes, expectedBracketLabel: r.expectedBracketLabel, eligible: esGratuita(r.modalidad) || !!vehiclePricing });
      }
      const playa = await manager.getRepository(Playa).findOneBy({ id: scope.playaId });
      const business = { name: playa?.nombre, address: playa?.direccion };
      const since = dayjs(now).tz(TZ).subtract(30, 'day').format('YYYY-MM-DD');
      const recentHourly = await manager.getRepository(TicketRegistration).find({
        where: { playaId: scope.playaId, departureDay: MoreThanOrEqual(since) }, relations: ['ticket'],
        order: { departureDay: 'DESC', departureTime: 'DESC' }, take: 100,
      });
      const recentPasses = await manager.getRepository(TicketRegistrationForDay).find({
        where: { playaId: scope.playaId, createdAt: MoreThanOrEqual(dayjs(now).subtract(30, 'day').toDate()) },
        order: { createdAt: 'DESC' }, take: 50,
      });
      const receiptIds = [...recentHourly, ...recentPasses].map(r => r.id);
      const issued = receiptIds.length ? await manager.getRepository(ParkingReceipt).find({
        where: { playaId: scope.playaId, registrationId: In(receiptIds), kind: In(['ENTRY', 'EXIT']) },
        select: { registrationId: true, kind: true, token: true },
      }) : [];
      const tokens = new Map(issued.map(r => [`${r.registrationId}:${r.kind}`, r.token]));
      const receipts = [
        ...recentHourly.flatMap(r => {
          if (esGratuita(r.modalidad) || !r.entryDay || !r.entryTime || !r.departureDay || !r.departureTime) return [];
          const entry = dayjs.tz(`${r.entryDay} ${r.entryTime}`, TZ).toISOString();
          const departure = dayjs.tz(`${r.departureDay} ${r.departureTime}`, TZ).toISOString();
          const base = { registrationId: r.id, plate: r.licensePlateOriginal || r.codeBarTicket || r.ticket?.codeBar || 'Sin patente', vehicleType: r.vehicleType || r.ticket?.vehicleType || '', entry, business, historical: true, synced: true };
          return [
            { ...base, id: `${r.id}:ENTRY`, kind: 'ENTRY', occurredAt: entry, operatorName: r.entryOperatorName, token: tokens.get(`${r.id}:ENTRY`) },
            { ...base, id: `${r.id}:EXIT`, kind: 'EXIT', occurredAt: departure, operatorName: r.exitOperatorName, price: r.price, token: tokens.get(`${r.id}:EXIT`) },
          ];
        }),
        ...recentPasses.flatMap(r => {
          const entry = new Date(r.createdAt).toISOString();
          const base = { registrationId: r.id, plate: r.vehiclePlateCustomer || r.lastNameCustomer || 'Sin patente', vehicleType: r.vehicleType || '', entry, business, historical: true, synced: true };
          return [
            { ...base, id: `${r.id}:ENTRY`, kind: 'ENTRY', occurredAt: entry, operatorName: r.entryOperatorName, token: tokens.get(`${r.id}:ENTRY`) },
            ...(r.retiredAt ? [{ ...base, id: `${r.id}:EXIT`, kind: 'EXIT', occurredAt: new Date(r.retiredAt).toISOString(), operatorName: r.exitOperatorName, price: r.price, token: tokens.get(`${r.id}:EXIT`) }] : []),
          ];
        }),
      ];
      const snapshot = { ...(await this.actions.extras(manager, gratuita)), version: 2, modalidad, userId: scope.userId, playaId: scope.playaId, operatorName, shift: shift ? { id: shift.id, name: shift.nombre } : null, shiftsEnabled: !gratuita && schedule.shiftsEnabled === true, business, receiptDelivery: gratuita ? null : schedule.receiptDelivery, capturedAt: now.toISOString(), expiresAt: now.getTime() + 86400000, pricing, types: types.map(t => ({ code: t.code, name: t.name })), vehicles, receipts: gratuita ? [] : receipts };
      // La sesión anterior sigue siendo inmutable para las pestañas con pendientes. Si la copia
      // conocida sigue vigente y su contenido es idéntico, evitamos bajarla y cifrarla otra vez.
      // Aun sin movimientos se renueva cada hora: quedan al menos 23 h de autorización local.
      if (knownSessionId && active && active.id === knownSessionId && active.expiresAt.getTime() - now.getTime() > 23 * 3600000 &&
          Object.keys(active.processed).length === 0 && offlineSnapshotFingerprint(active.snapshot) === offlineSnapshotFingerprint(snapshot)) {
        return { unchanged: true, sessionId: active.id, expiresAt: active.expiresAt.getTime() };
      }
      const session = await repo.save(repo.create({ playaId: scope.playaId, userId: scope.userId, deviceId, createdAt: now, expiresAt: new Date(snapshot.expiresAt), active: true, snapshot, processed: {} }));
      return { ...snapshot, sessionId: session.id, processedIds: [] };
    });
  }
  async synchronize(dto: OfflineOperationDto) {
    const scope = this.scope();
    const afterCommit: (() => void)[] = [];
    const saved = await this.ds.transaction(async manager => {
      // Same ordering as normal pricing/cash operations. The session row serializes retries.
      await manager.query('SELECT pg_advisory_xact_lock(718903)');
      await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const sessions = manager.getRepository(OfflineSession);
      const session = await sessions.findOne({ where: { id: dto.sessionId, playaId: scope.playaId, userId: scope.userId, deviceId: dto.deviceId }, lock: { mode: 'pessimistic_write' } });
      if (!session) throw new ForbiddenException('Esta contingencia pertenece a otro usuario o dispositivo.');
      const fingerprint = dto.kind === 'ACTION'
        ? offlineSnapshotFingerprint({ kind: dto.kind, action: dto.action, registrationId: dto.registrationId, occurredAt: dto.occurredAt, data: dto.data, expectedState: dto.expectedState, shiftId: dto.shiftId, cashSessionId: dto.cashSessionId })
        : createHash('sha256').update(JSON.stringify([dto.kind, dto.registrationId, dto.occurredAt, dto.plate, dto.vehicleType, dto.expectedPrice, dto.expectedCollected, dto.method])).digest('hex');
      const previous = session.processed[dto.id];
      if (previous) { if (previous.fingerprint !== fingerprint) throw new ConflictException('El identificador ya fue utilizado con otros datos.'); return { id: previous.registrationId }; }
      if (!session.active) throw new ConflictException('La contingencia fue finalizada. Conservá la operación para revisión.');
      // No reinterpretar ingresos ni cobros pendientes si cambió la modalidad durante el corte.
      const modalidad = session.snapshot.modalidad ?? 'CON_COBRO';
      const gratuita = esGratuita(modalidad);
      if ((await leerModalidad(manager, scope.playaId)) !== modalidad)
        throw new ConflictException({ code: 'MODALIDAD_CAMBIADA', message: 'Cambió la modalidad de la playa durante esta contingencia. La operación sigue pendiente para revisión.' });
      const time = Date.parse(dto.occurredAt);
      if (time < session.createdAt.getTime() - 120000 || time > session.expiresAt.getTime() || time > Date.now() + 120000) throw new ConflictException('La fecha de la operación está fuera del período autorizado.');
      if (dto.kind === 'ACTION') {
        const result = await this.actions.execute(manager, session, dto, afterCommit);
        if (!gratuita) await refreshAutomaticCuts(manager, new Date(time));
        session.processed[dto.id] = { fingerprint, registrationId: result.id, action: dto.action };
        await sessions.save(session);
        return result;
      }
      const repo = manager.getRepository(TicketRegistration);
      const operator = await manager.getRepository(User).findOne({ where: { id: scope.userId }, withDeleted: true });
      const operatorName = operator ? (`${operator.firstName} ${operator.lastName}`.trim() || operator.username) : 'Operador no disponible';
      let registration: TicketRegistration;
      if (dto.kind === 'ENTRY') {
        const plate = dto.plate?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!plate || !session.snapshot.types.some(t => t.code === dto.vehicleType)) throw new BadRequestException('Patente o tipo de vehículo inválido.');
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`plate:${plate}`]);
        if (await repo.exists({ where: { id: dto.registrationId } }) || await repo.exists({ where: { licensePlateNormalized: plate, departureTime: IsNull() } })) throw new ConflictException('La patente ya tiene un ingreso activo. Revisá el conflicto; no se duplicó la entrada.');
        const pricing = session.snapshot.pricing as PricingSnapshot | null;
        if (!gratuita) {
          assertPricingCoverage(pricing, dto.vehicleType, 'DAY'); assertPricingCoverage(pricing, dto.vehicleType, 'NIGHT');
        }
        const date = dayjs(time).tz(TZ);
        registration = await repo.save(repo.create({ id: dto.registrationId, playaId: scope.playaId, modalidad, description: `Entrada offline ${dto.id}`, price: 0, entryMode: 'PLATE', vehicleType: dto.vehicleType as any, licensePlateOriginal: dto.plate.trim().toUpperCase(), licensePlateNormalized: plate, licensePlateSearch: plate, entryDay: date.format('YYYY-MM-DD'), entryTime: date.format('HH:mm:ss'), pricingSnapshot: gratuita ? null : pricing, noPlate: false, entryOperatorName: operatorName }));
      } else {
        const known = session.snapshot.vehicles.find(v => v.id === dto.registrationId);
        const ownEntry = Object.values(session.processed).some(p => p.registrationId === dto.registrationId);
        if (!known && !ownEntry) throw new ForbiddenException('La estadía no forma parte de esta contingencia.');
        registration = await repo.findOne({ where: { id: dto.registrationId }, lock: { mode: 'pessimistic_write' } });
        if (!registration || registration.departureTime) throw new ConflictException('Otro operador ya registró esta salida. No se volvió a cobrar.');
        const withTicket = await repo.findOne({ where: { id: dto.registrationId }, relations: ['ticket'] });
        registration.ticket = withTicket.ticket;
        const entry = dayjs.tz(`${registration.entryDay} ${registration.entryTime}`, TZ).toDate();
        if (time < entry.getTime()) throw new BadRequestException('La salida no puede ser anterior a la entrada.');
        const vehicle = registration.vehicleType || registration.ticket?.vehicleType;
        const date = dayjs(time).tz(TZ);
        if (esGratuita(registration.modalidad)) {
          if (dto.method || (dto.expectedPrice ?? 0) !== 0 || (dto.expectedCollected ?? 0) !== 0)
            throw new BadRequestException({ code: 'ESTADIA_GRATUITA', message: 'La salida gratuita no admite importes ni medio de pago.' });
          Object.assign(registration, { exitTurnoId: null, departureDay: date.format('YYYY-MM-DD'), departureTime: date.format('HH:mm:ss'), codeBarTicket: registration.ticket?.codeBar ?? registration.codeBarTicket, vehicleType: vehicle, entryMode: registration.entryMode ?? (registration.ticket ? 'BARCODE' : 'PLATE'), ticket: null, description: `Salida offline ${dto.id}; ${dto.occurredAt}`, exitOperatorName: operatorName });
        } else {
          if (!registration.pricingSnapshot) throw new ConflictException('La estadía no tiene una copia de tarifas. Requiere revisión online.');
          const settings = await manager.getRepository(TicketScheduleSettings).findOne({ where: {} });
          let shiftId = session.snapshot.shiftsEnabled === true ? session.snapshot.shift?.id as string | undefined : undefined;
          if (shiftId) {
            if (!settings?.shiftsEnabled) throw new ConflictException('Cambió la configuración de turnos. Conservá la operación pendiente para revisión.');
            shiftId = (await offlineShift(manager, shiftId, scope.userId, new Date(time))).id;
          } else if (session.snapshot.shiftsEnabled !== true && settings?.shiftsEnabled === true) {
            throw new ConflictException('Los turnos se activaron durante esta contingencia. La operación sigue pendiente para revisión.');
          }
          const preview = calculateStayPrice(registration.pricingSnapshot, vehicle, entry, new Date(time));
          const [discount] = await manager.query("SELECT EXISTS(SELECT 1 FROM movimientos WHERE \"ticketRegistrationId\"=$1 AND tipo='DESCUENTO') AS present", [registration.id]);
          if (discount.present) throw new ConflictException('Esta estadía tiene un descuento registrado. Revisá el cierre con conexión.');
          const collected = await this.tickets.collectedAmount(registration, manager);
          if (preview.price !== dto.expectedPrice || collected !== dto.expectedCollected) throw new ConflictException('Cambió el importe o los anticipos. Conservá el cobro pendiente para revisión.');
          if (collected > preview.price) throw new ConflictException('La devolución de anticipos requiere revisión online.');
          if (!dto.method) throw new BadRequestException('Falta el medio de pago.');
          const amount = preview.price - collected;
          const capturedShiftId = session.snapshot.shiftsEnabled === true ? shiftId ?? null : undefined;
          if (amount > 0) await this.movements.create({ ticketRegistrationId: registration.id, usuarioId: scope.userId, monto: amount, metodo: dto.method, tipo: 'SALDO', referencia: `Offline ${dto.id}; fecha ${dto.occurredAt}` }, manager, capturedShiftId, new Date(time));
          const box = await this.boxes.applyTicketPayment(date.format('YYYY-MM-DD'), dto.method === 'CASH' ? amount : 0, manager, capturedShiftId, scope.userId, 'COBRO', new Date(time));
          Object.assign(registration, { exitTurnoId: capturedShiftId ?? null, departureDay: date.format('YYYY-MM-DD'), departureTime: date.format('HH:mm:ss'), dateNow: date.format('YYYY-MM-DD'), price: preview.price, pricingBreakdown: preview.breakdown, priceBracketLabel: preview.label, priceBracketFallbackUsed: preview.usedFallback, boxList: { id: box.id }, codeBarTicket: registration.ticket?.codeBar ?? registration.codeBarTicket, vehicleType: vehicle, entryMode: registration.entryMode ?? (registration.ticket ? 'BARCODE' : 'PLATE'), ticket: null, description: `Salida offline ${dto.id}; ${dto.occurredAt}`, exitOperatorName: operatorName });
        }
        registration = await repo.save(registration);
      }
      if (!gratuita) await refreshAutomaticCuts(manager, new Date(time));
      session.processed[dto.id] = { fingerprint, registrationId: registration.id };
      await sessions.save(session);
      return registration;
    });
    for (const publish of afterCommit) publish();
    if ('entryDay' in saved) this.gateway.emitNewRegistration(saved as TicketRegistration);
    return { status: 'SYNCED', operationId: dto.id, registrationId: saved.id };
  }
  async finish(dto: OfflineFinishDto) {
    const s = this.scope();
    return this.ds.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718903)');
      const repo = manager.getRepository(OfflineSession);
      const session = await repo.findOne({ where: { id: dto.sessionId, playaId: s.playaId, userId: s.userId, deviceId: dto.deviceId }, lock: { mode: 'pessimistic_write' } });
      if (!session) throw new ForbiddenException();
      session.active = false; await repo.save(session); return { ok: true };
    });
  }
}
