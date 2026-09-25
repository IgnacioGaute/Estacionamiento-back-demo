import { Injectable, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { createHash } from 'crypto';
import dayjs from 'dayjs';
import { tenantContext } from 'src/tenancy/tenant-context';
import { OfflineSession } from './entities/offline-session.entity';
import { TicketRegistration } from './entities/ticket-registration.entity';
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
const TZ = 'America/Argentina/Buenos_Aires';
@Injectable()
export class OfflineService {
  constructor(private readonly ds: DataSource, private readonly tickets: TicketsService, private readonly boxes: BoxListsService, private readonly movements: MovimientosService, private readonly gateway: TicketGateway) {}
  private scope() { const s = tenantContext.getStore(); if (!s?.userId || !s.playaId || !['USER', 'ADMIN'].includes(s.role)) throw new ForbiddenException(); return s; }
  async prepare(deviceId: string) {
    const scope = this.scope();
    return this.ds.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718903)');
      await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const schedule = await this.tickets.getSchedule(manager);
      if (schedule.shiftsEnabled !== false) throw new BadRequestException('Para operar offline, desactivá los turnos en Configuración.');
      const repo = manager.getRepository(OfflineSession);
      const active = await repo.findOne({ where: { playaId: scope.playaId, active: true } });
      if (active) {
        if (active.deviceId !== deviceId || active.userId !== scope.userId) throw new ConflictException('Otro dispositivo o usuario tiene la contingencia de esta playa. Debe sincronizar y finalizar antes de cambiarlo.');
        return { ...active.snapshot, sessionId: active.id, processedIds: Object.keys(active.processed) };
      }
      const now = new Date();
      const pricing: PricingSnapshot = { version: 1, capturedAt: now.toISOString(), schedule: { ...schedule, pricingDayTypeBasis: schedule.pricingDayTypeBasis ?? 'EXIT' }, brackets: await manager.getRepository(TicketPriceBracket).find() };
      const types = await manager.getRepository(VehicleTypeEntity).find({ where: { enabled: true } });
      const vehicles = [];
      for (const r of await manager.getRepository(TicketRegistration).find({ where: { departureTime: IsNull() }, relations: ['ticket'] })) {
        vehicles.push({ id: r.id, plate: r.licensePlateOriginal || r.codeBarTicket || r.ticket?.codeBar || 'Sin patente', vehicleType: r.vehicleType || r.ticket?.vehicleType, entry: dayjs.tz(`${r.entryDay} ${r.entryTime}`, TZ).toISOString(), pricing: r.pricingSnapshot, collected: await this.tickets.collectedAmount(r, manager), eligible: !!r.pricingSnapshot });
      }
      const snapshot = { version: 2, userId: scope.userId, playaId: scope.playaId, capturedAt: now.toISOString(), expiresAt: now.getTime() + 86400000, pricing, types: types.map(t => ({ code: t.code, name: t.name })), vehicles };
      const session = await repo.save(repo.create({ playaId: scope.playaId, userId: scope.userId, deviceId, createdAt: now, expiresAt: new Date(snapshot.expiresAt), active: true, snapshot, processed: {} }));
      return { ...snapshot, sessionId: session.id, processedIds: [] };
    });
  }
  async synchronize(dto: OfflineOperationDto) {
    const scope = this.scope();
    const saved = await this.ds.transaction(async manager => {
      // Same ordering as normal pricing/cash operations. The session row serializes retries.
      await manager.query('SELECT pg_advisory_xact_lock(718903)');
      await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const sessions = manager.getRepository(OfflineSession);
      const session = await sessions.findOne({ where: { id: dto.sessionId, playaId: scope.playaId, userId: scope.userId, deviceId: dto.deviceId }, lock: { mode: 'pessimistic_write' } });
      if (!session) throw new ForbiddenException('Esta contingencia pertenece a otro usuario o dispositivo.');
      const fingerprint = createHash('sha256').update(JSON.stringify([dto.kind, dto.registrationId, dto.occurredAt, dto.plate, dto.vehicleType, dto.expectedPrice, dto.expectedCollected, dto.method])).digest('hex');
      const previous = session.processed[dto.id];
      if (previous) { if (previous.fingerprint !== fingerprint) throw new ConflictException('El identificador ya fue utilizado con otros datos.'); return { id: previous.registrationId }; }
      if (!session.active) throw new ConflictException('La contingencia fue finalizada. Conservá la operación para revisión.');
      const time = Date.parse(dto.occurredAt);
      if (time < session.createdAt.getTime() - 120000 || time > session.expiresAt.getTime() || time > Date.now() + 120000) throw new ConflictException('La fecha de la operación está fuera del período autorizado.');
      const settings = await manager.getRepository(TicketScheduleSettings).findOne({ where: {} });
      if (settings?.shiftsEnabled !== false) throw new ConflictException('Los turnos fueron activados. Desactivalos antes de sincronizar esta contingencia.');
      const repo = manager.getRepository(TicketRegistration);
      let registration: TicketRegistration;
      if (dto.kind === 'ENTRY') {
        const plate = dto.plate?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!plate || !session.snapshot.types.some(t => t.code === dto.vehicleType)) throw new BadRequestException('Patente o tipo de vehículo inválido.');
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`plate:${plate}`]);
        if (await repo.exists({ where: { id: dto.registrationId } }) || await repo.exists({ where: { licensePlateNormalized: plate, departureTime: IsNull() } })) throw new ConflictException('La patente ya tiene un ingreso activo. Revisá el conflicto; no se duplicó la entrada.');
        const pricing = session.snapshot.pricing as PricingSnapshot;
        assertPricingCoverage(pricing, dto.vehicleType, 'DAY'); assertPricingCoverage(pricing, dto.vehicleType, 'NIGHT');
        const date = dayjs(time).tz(TZ);
        registration = await repo.save(repo.create({ id: dto.registrationId, playaId: scope.playaId, description: `Entrada offline ${dto.id}`, price: 0, entryMode: 'PLATE', vehicleType: dto.vehicleType as any, licensePlateOriginal: dto.plate.trim().toUpperCase(), licensePlateNormalized: plate, licensePlateSearch: plate, entryDay: date.format('YYYY-MM-DD'), entryTime: date.format('HH:mm:ss'), pricingSnapshot: pricing, noPlate: false }));
      } else {
        const known = session.snapshot.vehicles.find(v => v.id === dto.registrationId);
        const ownEntry = Object.values(session.processed).some(p => p.registrationId === dto.registrationId);
        if (!known && !ownEntry) throw new ForbiddenException('La estadía no forma parte de esta contingencia.');
        registration = await repo.findOne({ where: { id: dto.registrationId }, lock: { mode: 'pessimistic_write' } });
        if (!registration || registration.departureTime) throw new ConflictException('Otro operador ya registró esta salida. No se volvió a cobrar.');
        const withTicket = await repo.findOne({ where: { id: dto.registrationId }, relations: ['ticket'] });
        registration.ticket = withTicket.ticket;
        if (!registration.pricingSnapshot) throw new ConflictException('La estadía no tiene una copia de tarifas. Requiere revisión online.');
        const entry = dayjs.tz(`${registration.entryDay} ${registration.entryTime}`, TZ).toDate();
        if (time < entry.getTime()) throw new BadRequestException('La salida no puede ser anterior a la entrada.');
        const vehicle = registration.vehicleType || registration.ticket?.vehicleType;
        const preview = calculateStayPrice(registration.pricingSnapshot, vehicle, entry, new Date(time));
        const collected = await this.tickets.collectedAmount(registration, manager);
        if (preview.price !== dto.expectedPrice || collected !== dto.expectedCollected) throw new ConflictException('Cambió el importe o los anticipos. Conservá el cobro pendiente para revisión.');
        if (collected > preview.price) throw new ConflictException('La devolución de anticipos requiere revisión online.');
        if (!dto.method) throw new BadRequestException('Falta el medio de pago.');
        const amount = preview.price - collected;
        if (amount > 0) await this.movements.create({ ticketRegistrationId: registration.id, usuarioId: scope.userId, monto: amount, metodo: dto.method, tipo: 'SALDO', referencia: `Offline ${dto.id}; fecha ${dto.occurredAt}` }, manager);
        const date = dayjs(time).tz(TZ);
        const box = await this.boxes.applyTicketPayment(date.format('YYYY-MM-DD'), dto.method === 'CASH' ? amount : 0, manager);
        Object.assign(registration, { departureDay: date.format('YYYY-MM-DD'), departureTime: date.format('HH:mm:ss'), dateNow: date.format('YYYY-MM-DD'), price: preview.price, pricingBreakdown: preview.breakdown, priceBracketLabel: preview.label, priceBracketFallbackUsed: preview.usedFallback, boxList: { id: box.id }, codeBarTicket: registration.ticket?.codeBar ?? registration.codeBarTicket, vehicleType: vehicle, entryMode: registration.entryMode ?? (registration.ticket ? 'BARCODE' : 'PLATE'), ticket: null, description: `Salida offline ${dto.id}; ${dto.occurredAt}` });
        registration = await repo.save(registration);
      }
      session.processed[dto.id] = { fingerprint, registrationId: registration.id };
      await sessions.save(session);
      return registration;
    });
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
