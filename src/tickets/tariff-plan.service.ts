import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import dayjs from 'dayjs';
import { SimulateTariffPlanDto, TariffPlanDto, UpdateTariffPlanDto } from './dto/tariff-plan.dto';
import { TicketPriceBracket } from './entities/ticket-price-bracket.entity';
import { TicketScheduleSettings } from './entities/ticket-schedule-settings.entity';
import { VehicleTypeEntity } from './entities/vehicle-type.entity';
import { PricingBracket, PricingSchedule, PricingSnapshot } from './pricing/pricing.types';
import { validateBracket } from './pricing/pricing';
import { assertPricingCoverage, calculateStayPrice, validatePricingOptions } from './pricing/stay-pricing';
import { TicketsService } from './tickets.service';

export interface TariffPlan {
  revision: string;
  schedule: PricingSchedule;
  brackets: PricingBracket[];
}

// Ordenar las claves evita conflictos falsos por el orden que utiliza JSONB.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

const bracketScope = (row: { vehicleType: string; ticketDayType?: string | null; uptoMinutes?: number | null }) => `${row.vehicleType}:${row.ticketDayType ?? 'ALL'}:${row.uptoMinutes ?? 'OPEN'}`;

@Injectable()
export class TariffPlanService {
  constructor(private readonly dataSource: DataSource, private readonly tickets: TicketsService) {}

  private scheduleFields(schedule: PricingSchedule): PricingSchedule {
    const options = schedule.pricingOptions!;
    return {
      dayStartHour: schedule.dayStartHour,
      dayEndHour: schedule.dayEndHour,
      graceMinutes: schedule.graceMinutes,
      pricingDayTypeBasis: schedule.pricingDayTypeBasis,
      pricingOptions: {
        charging: { ...options.charging, rates: options.charging.rates.map(row => ({ ...row })) },
        stay: { ...options.stay, enabled: false, caps: options.stay.caps.map(row => ({ ...row })) },
        crossing: { ...options.crossing },
      },
    };
  }

  private bracketFields(row: PricingBracket): PricingBracket {
    return { id: row.id, vehicleType: row.vehicleType, ticketDayType: row.ticketDayType ?? null, label: row.label, uptoMinutes: row.uptoMinutes ?? null, price: row.price, recurringUnitMinutes: row.recurringUnitMinutes ?? null, recurringPriceMode: row.recurringPriceMode ?? 'DERIVED' };
  }

  private async read(manager: EntityManager) {
    const schedule = this.scheduleFields(await this.tickets.getSchedule(manager));
    const rows = await manager.getRepository(TicketPriceBracket).find({ order: { id: 'ASC' } });
    const vehicles = await manager.getRepository(VehicleTypeEntity).find({ order: { code: 'ASC' } });
    const brackets = rows.map(row => this.bracketFields(row));
    // El catálogo también interviene en la validación completa al aplicar un borrador.
    const revision = createHash('sha256').update(JSON.stringify(canonical({ schedule, brackets, vehicles: vehicles.map(({ code, enabled }) => ({ code, enabled })) }))).digest('hex');
    return { plan: { revision, schedule, brackets } as TariffPlan, rows, vehicles };
  }

  getPlan(): Promise<TariffPlan> {
    return this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock_shared(718903)');
      return (await this.read(manager)).plan;
    });
  }

  private prepare(dto: TariffPlanDto, current: PricingBracket[], vehicles: VehicleTypeEntity[], complete: boolean): Omit<TariffPlan, 'revision'> {
    const schedule = this.scheduleFields(dto.schedule);
    if (schedule.dayStartHour === schedule.dayEndHour) throw new BadRequestException('El inicio y el fin del horario diurno deben ser diferentes.');
    validatePricingOptions(schedule.pricingOptions!);
    const vehicleCodes = new Set(vehicles.map(vehicle => vehicle.code));
    const ids = new Set<string>();
    const brackets = dto.brackets.map((row, index) => {
      if (row.id && ids.has(row.id)) throw new BadRequestException('Hay franjas con el mismo identificador.');
      if (row.id) ids.add(row.id);
      const previous = row.id ? current.find(saved => saved.id === row.id) : current.find(saved => bracketScope(saved) === bracketScope(row));
      if (complete && row.id && !previous) throw new BadRequestException('Una de las franjas ya no existe en esta playa. Volvé a cargar las tarifas.');
      if (!row.label.trim()) throw new BadRequestException('Ingresá el nombre de cada duración.');
      return this.bracketFields({ ...row, id: previous?.id ?? row.id ?? `draft-${index}`, label: row.label.trim(), ticketDayType: row.ticketDayType ?? null, uptoMinutes: row.uptoMinutes ?? null, recurringUnitMinutes: row.recurringUnitMinutes ?? null, recurringPriceMode: row.recurringPriceMode ?? previous?.recurringPriceMode ?? 'FIXED' });
    });
    // Comprobar por alcance, sin depender del id: un borrador puede contener filas nuevas.
    if (new Set(brackets.map(bracketScope)).size !== brackets.length) throw new BadRequestException({ code: 'DUPLICATE_PRICE_BRACKET', message: 'Hay duraciones repetidas para el mismo vehículo y horario.' });
    if (new Set(brackets.map(row => row.id)).size !== brackets.length) throw new BadRequestException('Hay franjas con el mismo identificador.');
    for (const row of brackets) {
      if (!vehicleCodes.has(row.vehicleType)) throw new BadRequestException(`El vehículo ${row.vehicleType} no existe en esta playa.`);
      validateBracket(row, brackets);
    }
    for (const rate of schedule.pricingOptions!.charging.rates) {
      if (!vehicleCodes.has(rate.vehicleType)) throw new BadRequestException(`El vehículo ${rate.vehicleType} no existe en esta playa.`);
    }
    if (complete) {
      const snapshot: PricingSnapshot = { version: 1, capturedAt: new Date().toISOString(), schedule, brackets };
      for (const vehicle of vehicles.filter(row => row.enabled)) {
        for (const dayType of ['DAY', 'NIGHT'] as const) {
          try { assertPricingCoverage(snapshot, vehicle.code, dayType); }
          catch { throw new BadRequestException({ code: 'TARIFF_PLAN_INCOMPLETE', message: `Completá el precio de ${vehicle.name} para el horario ${dayType === 'DAY' ? 'diurno' : 'nocturno'} antes de aplicar las tarifas.` }); }
        }
      }
    }
    return { schedule, brackets };
  }

  updatePlan(dto: UpdateTariffPlanDto): Promise<TariffPlan> {
    return this.dataSource.transaction(async manager => {
      // Es el mismo bloqueo que usa el ingreso al congelar sus precios y la edición anterior.
      await manager.query('SELECT pg_advisory_xact_lock(718903)');
      const { plan: current, rows, vehicles } = await this.read(manager);
      if (dto.expectedRevision !== current.revision) throw new ConflictException({ code: 'TARIFF_PLAN_CHANGED', message: 'Las tarifas o los vehículos cambiaron desde que abriste el borrador. Volvé a cargar la configuración antes de aplicar.' });
      const plan = this.prepare(dto, current.brackets, vehicles, true);
      const bracketRepo = manager.getRepository(TicketPriceBracket);
      const retained = new Set(plan.brackets.map(row => row.id));
      const removed = rows.filter(row => !retained.has(row.id));
      if (removed.length) await bracketRepo.remove(removed);
      for (const bracket of plan.brackets) {
        const previous = rows.find(row => row.id === bracket.id);
        const { id, ...fields } = bracket;
        // Conservar los ids permite seguir usando enlaces y editores existentes.
        await bracketRepo.save(bracketRepo.create({ ...previous, ...fields }));
      }
      const scheduleRepo = manager.getRepository(TicketScheduleSettings);
      const [stored] = await scheduleRepo.find({ order: { updatedAt: 'DESC' }, take: 1 });
      // Sólo se escriben campos tarifarios; recibos, tarjetas y turnos conservan su estado.
      await scheduleRepo.save(scheduleRepo.create({ ...stored, ...plan.schedule }));
      return (await this.read(manager)).plan;
    });
  }

  simulate(dto: SimulateTariffPlanDto) {
    return this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock_shared(718903)');
      const { plan: current, vehicles } = await this.read(manager);
      if (!vehicles.some(vehicle => vehicle.code === dto.vehicleType && vehicle.enabled)) throw new BadRequestException('El tipo de vehículo no existe o está desactivado.');
      // Se puede probar un vehículo terminado aunque falten precios de otros vehículos.
      const plan = dto.plan ? this.prepare(dto.plan, current.brackets, vehicles, false) : current;
      const snapshot: PricingSnapshot = { version: 1, capturedAt: new Date().toISOString(), schedule: plan.schedule, brackets: plan.brackets };
      const entry = dayjs(dto.entryAt);
      return calculateStayPrice(snapshot, dto.vehicleType, entry.toDate(), entry.add(dto.elapsedMinutes, 'minute').toDate());
    });
  }
}
