import { publishAutomaticNote } from 'src/notes/automatic-note';
import { externalPayment, operatorShift, recordDigital, reverseDigital } from 'src/turnos/turno-book';
import { VehicleTypeEntity } from './entities/vehicle-type.entity';
import { ListPagination, listResult } from 'src/utils/list-pagination';
import { CreateVehicleTypeDto, UpdateVehicleTypeDto } from './dto/vehicle-type.dto';
import { assertPricingCoverage, calculateStayPrice, validatePricingOptions } from './pricing/stay-pricing';
import { defaultPricingOptions, PricingOptions } from './pricing/pricing.types';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { tenantContext } from 'src/tenancy/tenant-context';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { Ticket } from './entities/ticket.entity';
import { TicketRegistration } from './entities/ticket-registration.entity';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { BoxListsService } from 'src/box-lists/box-lists.service';
import { BoxList } from 'src/box-lists/entities/box-list.entity';
import { TicketGateway } from './register-gateway';
import { FilterOperator, paginate, Paginated, PaginateQuery } from 'nestjs-paginate';
import { TicketRegistrationForDay } from './entities/ticket-registration-for-day.entity';
import { User } from 'src/users/entities/user.entity';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import isBetween from 'dayjs/plugin/isBetween';
import { TicketPrice } from './entities/ticket-price.entity';
import { CreateTicketPriceDto } from './dto/create-ticket-price.dto';
import { UpdateTicketPriceDto } from './dto/update-ticket-price.dto';
import { TicketPriceBracket } from './entities/ticket-price-bracket.entity';
import { CreateTicketPriceBracketDto } from './dto/create-ticket-price-bracket.dto';
import { UpdateTicketPriceBracketDto } from './dto/update-ticket-price-bracket.dto';
import { AdvancePaymentTicketRegistrationDto } from './dto/advance-payment-ticket-registration.dto';
import { CorregirDatosEstadiaDto } from './dto/corregir-datos-estadia.dto';
import { TicketScheduleSettings } from './entities/ticket-schedule-settings.entity';
import { UpdateTicketScheduleDto } from './dto/update-ticket-schedule.dto';
import { MovimientosService } from 'src/movimientos/movimientos.service';
import { MovimientoMetodo } from 'src/movimientos/entities/movimiento.entity';
import { CreateRegistrationByPlateDto } from './dto/create-registration-by-plate.dto';
import { DiscountRegistrationDto } from './dto/discount-registration.dto';
import { PagoParcialDto } from './dto/pago-parcial.dto';
import { Movimiento } from 'src/movimientos/entities/movimiento.entity';
import { CloseRegistrationDto } from './dto/close-registration.dto';
import { normalizePlate, patentesParecidas, toSearchKey } from './utils/license-plate.util';
import { Brackets } from 'typeorm';
import { resolveDayType, validateBracket } from './pricing/pricing';
import { PricingSnapshot } from './pricing/pricing.types';
import { CreateTicketRegistrationForDayDto, UpdateTicketStatusDto } from './dto/create-ticket-registration-for-day.dto';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isBetween);

@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  private async operatorName(userId: string, manager: EntityManager): Promise<string> {
    const user = await manager.getRepository(User).findOne({ where: { id: userId }, withDeleted: true });
    if (!user) return 'Operador no disponible';
    return `${user.firstName} ${user.lastName}`.trim() || user.username;
  }

  constructor(
    @InjectRepository(Ticket)
    private readonly ticketRepository: Repository<Ticket>,
    @InjectRepository(TicketPrice)
    private readonly ticketPriceRepository: Repository<TicketPrice>,
    @InjectRepository(TicketPriceBracket)
    private readonly ticketPriceBracketRepository: Repository<TicketPriceBracket>,
    @InjectRepository(TicketRegistration)
    private readonly ticketRegistrationRepository: Repository<TicketRegistration>,
    @InjectRepository(TicketRegistrationForDay)
    private readonly ticketRegistrationForDayRepository: Repository<TicketRegistrationForDay>,
    @InjectRepository(TicketScheduleSettings)
    private readonly ticketScheduleSettingsRepository: Repository<TicketScheduleSettings>,
    private readonly boxListsService: BoxListsService,
    private readonly ticketGateway: TicketGateway,
    private readonly movimientosService: MovimientosService,
    private readonly dataSource: DataSource,
  ) {}

  async createTicketPrice(createTicketPriceDto: CreateTicketPriceDto) {
    if (createTicketPriceDto.vehicleType) await this.assertVehicleType(createTicketPriceDto.vehicleType);
    try {

      if(createTicketPriceDto.vehicleType && createTicketPriceDto.ticketDayType){
        const type = await this.ticketPriceRepository.findOne({where:{vehicleType:createTicketPriceDto.vehicleType, ticketTimeType: IsNull()}})
        if(type && type.ticketDayType === createTicketPriceDto.ticketDayType){
          throw new NotFoundException({
            code: 'TICKET_PRICE_TYPE_FOUND',
            message: `Ya existe un precio ticket con el tipo de vehiculo ${createTicketPriceDto.vehicleType}`,
          });
        }
      }else if(createTicketPriceDto.ticketTimeType){
        const ticketTime = await this.ticketPriceRepository.find({
            where: {
              ticketTimeType: createTicketPriceDto.ticketTimeType,
              vehicleType: createTicketPriceDto.vehicleType,
            },
          });
        if(ticketTime.length > 0){
          throw new NotFoundException({
            code: 'TICKET_TIME_PRICE_TYPE_FOUND',
            message: `Ya existe un precio para el tipo de ticket ${createTicketPriceDto.ticketTimeType} con el tipo ${createTicketPriceDto.vehicleType}`,
          });
        }
      }
      const ticketPrice = this.ticketPriceRepository.create(createTicketPriceDto);

      const savedTicket = await this.ticketPriceRepository.save(ticketPrice);

      return savedTicket;
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
      throw error;
    }
  }

  async findAllTicketPrice(query: PaginateQuery): Promise<Paginated<TicketPrice>> {
    try {
      return await paginate(query, this.ticketPriceRepository, {
        sortableColumns: ['id'],
        nullSort: 'last',
        searchableColumns: ['vehicleType', 'ticketTimeType'],
        filterableColumns: {
          vehicleType: [FilterOperator.EQ, FilterOperator.ILIKE],
          ticketTimeType: [FilterOperator.EQ, FilterOperator.ILIKE],
        },
      });
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
    }
  }

async updateTicketPrice(id: string, updateTicketPriceDto: UpdateTicketPriceDto) {
    if (updateTicketPriceDto.vehicleType) await this.assertVehicleType(updateTicketPriceDto.vehicleType);
  try{
    const ticketPrice = await this.ticketPriceRepository.findOne({where:{id:id}})
    if(updateTicketPriceDto.vehicleType && updateTicketPriceDto.ticketTimeType === null){
      const type = await this.ticketPriceRepository.find({where:{vehicleType:updateTicketPriceDto.vehicleType}})
      if(type && ticketPrice.vehicleType !== updateTicketPriceDto.vehicleType){
        throw new NotFoundException({
          code: 'TICKET_PRICE_TYPE_FOUND',
          message: `Ya existe un precio ticket con el tipo de vehiculo ${updateTicketPriceDto.vehicleType}`,
        });
      }
    } else if(updateTicketPriceDto.ticketTimeType){
        const ticketTime = await this.ticketPriceRepository.find({
            where: {
              ticketTimeType: updateTicketPriceDto.ticketTimeType,
              vehicleType: updateTicketPriceDto.vehicleType,
            },
          });
        if(ticketTime && ticketPrice.ticketTimeType !== updateTicketPriceDto.ticketTimeType){
          throw new NotFoundException({
            code: 'TICKET_TIME_PRICE_TYPE_FOUND',
            message: `Ya existe un precio para el tipo de ticket ${updateTicketPriceDto.ticketTimeType} con el tipo ${updateTicketPriceDto.vehicleType}`,
          });
        }
    }

    if(!ticketPrice){
      throw new NotFoundException('Ticket Price not found')
    }

    const tickets = await this.ticketRepository.find({where:{vehicleType:updateTicketPriceDto.vehicleType, ticketDayType: updateTicketPriceDto.ticketDayType}});

    for(const ticket of tickets){
      ticket.price = updateTicketPriceDto.price;
      await this.ticketRepository.save(ticket);
    }
   
    const updateTicket = this.ticketPriceRepository.merge(ticketPrice, updateTicketPriceDto);

    const savedTicket = await this.ticketPriceRepository.save(updateTicket); 

    return savedTicket;
  } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
}

async removeTicketPrice(id: string) {
  try{
    const ticket = await this.ticketPriceRepository.findOne({where:{id:id}})

    if(!ticket){
      throw new NotFoundException('Ticket Price not found')
    }

    await this.ticketPriceRepository.remove(ticket);

    return {message: 'Ticket Price removed successfully'}
  } catch (error: any) {
    if (!(error instanceof NotFoundException)) {
      this.logger.error(error.message, error.stack);
    }
    throw error;
  }
}


  private readonly defaultTicketSchedule = { dayStartHour: 8, dayEndHour: 20, graceMinutes: 5, barcodeTicketsEnabled: false, shiftsEnabled: false, multipleShiftsEnabled: false, pricingDayTypeBasis: 'EXIT' as const };

  async getSchedule(manager?: EntityManager) {
    const repository = manager ? manager.getRepository(TicketScheduleSettings) : this.ticketScheduleSettingsRepository;
    const [latest] = await repository.find({ order: { updatedAt: 'DESC' }, take: 1 });
    const storedOptions = latest?.pricingOptions ?? defaultPricingOptions();
    // La permanencia se retiró de la configuración actual. Las copias guardadas en
    // estadías abiertas siguen intactas; ninguna entrada nueva usa reglas ocultas.
    return { ...(latest ?? this.defaultTicketSchedule), receiptDelivery: latest?.receiptDelivery ?? { whatsapp: false, qr: false, print: false, paperWidth: 80 as const }, pricingOptions: { ...storedOptions, stay: { ...storedOptions.stay, enabled: false } } };
  }

  async updateSchedule(dto: UpdateTicketScheduleDto) {
    return this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718903)');
      if (dto.shiftsEnabled === false) {
        await manager.query('SELECT pg_advisory_xact_lock(718904)');
        const open = await manager.query(`SELECT id FROM turnos WHERE estado = 'ABIERTO' LIMIT 1`);
        if (open.length) throw new BadRequestException('Cerrá todos los turnos abiertos antes de desactivar los turnos.');
      }
      if (dto.pricingOptions) {
        dto.pricingOptions = { ...dto.pricingOptions, stay: { ...dto.pricingOptions.stay, enabled: false } };
        validatePricingOptions(dto.pricingOptions);
        const activeTypes = await manager.getRepository(VehicleTypeEntity).find({ where: { enabled: true } });
        const options = dto.pricingOptions;
        for (const vehicle of activeTypes) {
          if (options.charging.enabled && !options.charging.rates.some(r => r.vehicleType === vehicle.code)) throw new BadRequestException(`Falta el precio por unidad para ${vehicle.name}.`);
          if (options.stay.enabled && options.stay.capEnabled && !options.stay.caps.some(r => r.vehicleType === vehicle.code)) throw new BadRequestException(`Falta el tope para ${vehicle.name}.`);
        }
      }
      const repository = manager.getRepository(TicketScheduleSettings);
      const [current] = await repository.find({ order: { updatedAt: 'DESC' }, take: 1 });
      const merged = { ...this.defaultTicketSchedule, ...current, ...dto };
      if (dto.shiftsEnabled === false) merged.multipleShiftsEnabled = false;
      if (merged.sueldoAutomatico && !(merged.sueldoPorTurno > 0)) throw new BadRequestException('Indicá un importe de sueldo mayor que cero.');
      if (merged.multipleShiftsEnabled && !merged.shiftsEnabled) throw new BadRequestException('Activá Turnos de caja antes de permitir turnos múltiples.');
      if (merged.multipleShiftsEnabled !== (current?.multipleShiftsEnabled ?? false)) {
        await manager.query('SELECT pg_advisory_xact_lock(718904)');
        const open = await manager.query("SELECT id FROM turnos WHERE estado = 'ABIERTO' LIMIT 1");
        if (open.length) throw new ConflictException('Cerrá todos los turnos antes de cambiar el modo de trabajo.');
      }
      if (merged.pricingOptions) merged.pricingOptions = { ...merged.pricingOptions, stay: { ...merged.pricingOptions.stay, enabled: false } };
      if (merged.dayStartHour === merged.dayEndHour) throw new BadRequestException('El inicio y el fin del horario diurno deben ser diferentes.');
      return repository.save(repository.create(merged));
    });
  }

  private async capturePricing(vehicleType: string, manager?: EntityManager, opening = true): Promise<PricingSnapshot> {
    if (manager) await manager.query('SELECT pg_advisory_xact_lock_shared(718903)');
    if (opening) await this.assertVehicleType(vehicleType, manager);
    const schedule = await this.getSchedule(manager);
    const repository = manager ? manager.getRepository(TicketPriceBracket) : this.ticketPriceBracketRepository;
    const brackets = await repository.find({ where: { vehicleType: vehicleType as any } });
    const snapshot: PricingSnapshot = {
      version: 1, capturedAt: new Date().toISOString(),
      schedule: { dayStartHour: schedule.dayStartHour, dayEndHour: schedule.dayEndHour, graceMinutes: schedule.graceMinutes, pricingDayTypeBasis: schedule.pricingDayTypeBasis ?? 'EXIT', pricingOptions: schedule.pricingOptions },
      brackets,
    };
    const dayType = resolveDayType(snapshot.schedule, dayjs().tz('America/Argentina/Buenos_Aires').hour());
    if (opening) assertPricingCoverage(snapshot, vehicleType, dayType);
    if (opening && (snapshot.schedule.pricingDayTypeBasis === 'EXIT' || snapshot.schedule.pricingOptions?.crossing.enabled)) {
      assertPricingCoverage(snapshot, vehicleType, 'DAY');
      assertPricingCoverage(snapshot, vehicleType, 'NIGHT');
    }
    return snapshot;
  }

  // Pasar las estadías que siguen adentro a las tarifas recién aplicadas (lo pide el administrador
  // al aplicar). Se recalcula toda la estadía, desde la entrada; lo ya cobrado sigue descontándose y
  // un pago de más se devuelve al cerrar. Corre en la transacción de updatePlan, que ya tiene el
  // bloqueo exclusivo de tarifas. Una estadía que la tarifa nueva no cubre (vehículo desactivado y
  // sin precios) conserva la suya: cobrarla después fallaría.
  async repriceActiveStays(manager: EntityManager): Promise<{ actualizadas: number; omitidas: number }> {
    const settings = await this.getSchedule(manager);
    const schedule = { dayStartHour: settings.dayStartHour, dayEndHour: settings.dayEndHour, graceMinutes: settings.graceMinutes, pricingDayTypeBasis: settings.pricingDayTypeBasis ?? 'EXIT', pricingOptions: settings.pricingOptions };
    const brackets = await manager.getRepository(TicketPriceBracket).find();
    const repository = manager.getRepository(TicketRegistration);
    let actualizadas = 0, omitidas = 0;
    for (const registration of await repository.find({ where: { departureTime: IsNull() }, relations: ['ticket'] })) {
      // Sin copia ya se cobra con la tarifa vigente.
      if (!registration.pricingSnapshot) continue;
      const vehicle = registration.vehicleType ?? registration.ticket?.vehicleType;
      if (!vehicle) { omitidas++; continue; }
      // capturedAt queda como estaba: es cuándo entró, no cuándo cambió la tarifa.
      const snapshot: PricingSnapshot = { version: 1, capturedAt: registration.pricingSnapshot.capturedAt, schedule, brackets: brackets.filter(row => row.vehicleType === vehicle) };
      try { assertPricingCoverage(snapshot, vehicle, 'DAY'); assertPricingCoverage(snapshot, vehicle, 'NIGHT'); }
      catch { omitidas++; continue; }
      await repository.update({ id: registration.id }, { pricingSnapshot: snapshot });
      actualizadas++;
    }
    return { actualizadas, omitidas };
  }

  countActiveStays(manager: EntityManager) {
    return manager.getRepository(TicketRegistration).count({ where: { departureTime: IsNull() } });
  }

  private async priceRegistration(registration: TicketRegistration, manager?: EntityManager, salida: Date = new Date()) {
    const vehicle = registration.vehicleType ?? registration.ticket?.vehicleType;
    if (!vehicle) throw new BadRequestException('El registro no tiene tipo de vehículo.');
    const snapshot = registration.pricingSnapshot ?? await this.capturePricing(vehicle, manager, false);
    const entry = dayjs.tz(`${registration.entryDay} ${registration.entryTime}`, 'YYYY-MM-DD HH:mm:ss', 'America/Argentina/Buenos_Aires');
    const calculated = calculateStayPrice(snapshot, vehicle, entry.toDate(), salida);
    const { total } = await (manager ?? this.dataSource.manager).getRepository(Movimiento).createQueryBuilder('m')
      .select('COALESCE(SUM(m.monto), 0)', 'total')
      .where("m.ticketRegistrationId = :id AND m.tipo = 'DESCUENTO'", { id: registration.id }).getRawOne();
    const descuentoTotal = Math.min(calculated.price, Number(total));
    return { ...calculated, price: calculated.price - descuentoTotal, descuentoTotal,
      breakdown: [...calculated.breakdown, ...(descuentoTotal ? [{ label: 'Descuento aplicado', amount: -descuentoTotal }] : [])],
      tariffSnapshotUsed: !!registration.pricingSnapshot };
  }

  async previewPrice(vehicleType: string, ticketDayType: 'DAY' | 'NIGHT', elapsedMinutes: number, entryAt?: string, options?: PricingOptions) {
    return this.dataSource.transaction(async manager => {
      const snapshot = await this.capturePricing(vehicleType, manager, false);
      await this.assertVehicleType(vehicleType, manager);
      if (options) {
        const liveOptions = { ...options, stay: { ...options.stay, enabled: false } };
        validatePricingOptions(liveOptions);
        snapshot.schedule.pricingOptions = liveOptions;
      }
      const hour = ticketDayType === 'NIGHT' ? snapshot.schedule.dayEndHour : snapshot.schedule.dayStartHour;
      const entry = entryAt ? dayjs(entryAt) : dayjs().tz('America/Argentina/Buenos_Aires').startOf('day').hour(hour);
      return calculateStayPrice(snapshot, vehicleType, entry.toDate(), entry.add(elapsedMinutes, 'minute').toDate());
    });
  }

  async getVehicleTypes() {
    return this.dataSource.getRepository(VehicleTypeEntity).find({ order: { code: 'ASC' } });
  }

  private async assertVehicleType(code: string, manager?: EntityManager) {
    const vehicle = await (manager ?? this.dataSource.manager).getRepository(VehicleTypeEntity).findOneBy({ code, enabled: true });
    if (!vehicle) throw new BadRequestException('El tipo de vehículo no existe o está desactivado.');
  }

  async createVehicleType(dto: CreateVehicleTypeDto) {
    return this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718903)');
      const repo = manager.getRepository(VehicleTypeEntity);
      if (await repo.exists({ where: { code: dto.code } })) throw new BadRequestException('Ya existe ese código de vehículo.');
      if (!dto.name.trim()) throw new BadRequestException('Ingresá el nombre del vehículo.');
      return repo.save(repo.create({ ...dto, name: dto.name.trim(), enabled: true }));
    });
  }

  async updateVehicleType(code: string, dto: UpdateVehicleTypeDto) {
    return this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718903)');
      const repo = manager.getRepository(VehicleTypeEntity);
      const vehicle = await repo.findOneBy({ code });
      if (!vehicle) throw new NotFoundException('Tipo de vehículo no encontrado.');
      if (dto.name !== undefined && !dto.name.trim()) throw new BadRequestException('Ingresá el nombre del vehículo.');
      return repo.save(repo.merge(vehicle, { ...dto, ...(dto.name !== undefined ? { name: dto.name.trim() } : {}) }));
    });
  }

  async create(createTicketDto: CreateTicketDto) {
    await this.assertVehicleType(createTicketDto.vehicleType);
    try {
      const ticket = this.ticketRepository.create(createTicketDto);
      const savedTicket = await this.ticketRepository.save(ticket);

      return savedTicket;
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
      throw error;
    }
  }

    async findAll(query: PaginateQuery): Promise<Paginated<Ticket>> {
      try {
        return await paginate(query, this.ticketRepository, {
          sortableColumns: ['id'],
          nullSort: 'last',
          searchableColumns: ['codeBar', 'vehicleType'],
          filterableColumns: {
            codeBar: [FilterOperator.ILIKE, FilterOperator.EQ],
            vehicleType: [FilterOperator.EQ, FilterOperator.ILIKE],
          },
        });
      } catch (error: any) {
        this.logger.error(error.message, error.stack);
      }
    }

  async update(id: string, updateTicketDto: UpdateTicketDto) {
    if (updateTicketDto.vehicleType) await this.assertVehicleType(updateTicketDto.vehicleType);
    try{
      const ticket = await this.ticketRepository.findOne({where:{id:id}})

      if(!ticket){
        throw new NotFoundException('Ticket not found')
      }
      
      const updateTicket = this.ticketRepository.merge(ticket, updateTicketDto);

      const savedTicket = await this.ticketRepository.save(updateTicket);

      return savedTicket;
    } catch (error: any) {
        if (!(error instanceof NotFoundException)) {
          this.logger.error(error.message, error.stack);
        }
        throw error;
      }
  }

  async remove(id: string) {
    try{
      const ticket = await this.ticketRepository.findOne({where:{id:id}})

      if(!ticket){
        throw new NotFoundException('Ticket list not found')
      }

      await this.ticketRepository.remove(ticket);

      return {message: 'Ticket list removed successfully'}
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  async findTicketByCode (codeBar: string){
    const ticket = await this.ticketRepository.findOne({ where: { codeBar:codeBar } });
    if (!ticket) {
        this.logger.warn(`No se encontró un ticket con el código de barras: ${codeBar}`);
        return null;
    }
    return ticket;
  }

  async createRegistration(ticketId?: string, userId?: string) {
    if (!ticketId) throw new BadRequestException('Falta el identificador del ticket.');
    const result = await this.dataSource.transaction(async manager => {
      const ticket = await manager.getRepository(Ticket).findOne({ where: { id: ticketId }, lock: { mode: 'pessimistic_write' } });
      if (!ticket) throw new NotFoundException('Ticket no encontrado.');
      const repository = manager.getRepository(TicketRegistration);
      const existing = await repository.findOne({ where: { ticket: { id: ticketId }, departureTime: IsNull() }, relations: ['ticket'] });
      // El segundo escaneo prepara el cierre; nunca registra un cobro implícito.
      if (existing) return { registration: existing, requiresClose: true };
      // Una empresa suspendida puede escanear para sacar un auto, pero no para entrar uno nuevo.
      if (tenantContext.getStore()?.suspendida)
        throw new ForbiddenException({
          code: 'EMPRESA_SUSPENDIDA',
          message: 'La cuenta está suspendida: solo se pueden registrar salidas.',
        });
      const pricingSnapshot = await this.capturePricing(ticket.vehicleType, manager);
      const entryOperatorName = userId ? await this.operatorName(userId, manager) : null;
      const now = dayjs(pricingSnapshot.capturedAt).tz('America/Argentina/Buenos_Aires');
      const registration = await repository.save(repository.create({
        description: `Registro de ticket para vehículo tipo ${ticket.vehicleType}`, price: 0,
        entryDay: now.format('YYYY-MM-DD'), entryTime: now.format('HH:mm:ss'),
        ticket, vehicleType: ticket.vehicleType as any, codeBarTicket: ticket.codeBar,
        pricingSnapshot, entryMode: 'BARCODE',
        entryOperatorName,
      }));
      return { registration, requiresClose: false };
    });
    if (!result.requiresClose) this.ticketGateway.emitNewRegistration(result.registration);
    return result;
  }

// Nombre en español de cada tipo de duración — se usa tanto en la descripción del abono como
// en el mensaje de error cuando falta cargar la tarifa correspondiente en Tarifas.
private readonly ticketTimeTypeLabel: Record<string, string> = {
  DIA: 'día/s',
  SEMANA: 'semana/s',
  MES: 'mes/es',
  SEMANA_Y_DIA: 'semana/s y día/s',
  MES_Y_DIA: 'mes/es y día/s',
};

// Busca la tarifa por día/semana/mes cargada en Tarifas para ese tipo y vehículo — si no está
// configurada, corta el alta con un error que nombra exactamente cuál falta (día, semana o
// mes), en vez de dejar pasar un precio en $0 o uno de los dos términos de una franja combinada.
private async getTicketTimePriceOrThrow(
  ticketTimeType: 'DIA' | 'SEMANA' | 'MES',
  vehicleType: string,
) {
  const ticketPrice = await this.ticketPriceRepository.findOne({
    where: { ticketTimeType: ticketTimeType as any, vehicleType: vehicleType as any },
  });
  if (!ticketPrice) {
    throw new NotFoundException({
      code: 'TICKET_PRICE_NOT_FOUND',
      message: `No hay una tarifa por ${this.ticketTimeTypeLabel[ticketTimeType]} configurada para ${vehicleType}. Pedile al admin que la cargue en Tarifas antes de registrar este abono.`,
    });
  }
  return ticketPrice;
}

async createRegistrationForDay(createTicketRegistrationForDayDto: CreateTicketRegistrationForDayDto, userId?: string) {
  await this.assertVehicleType(createTicketRegistrationForDayDto.vehicleType);
  return this.dataSource.transaction(async manager => {
  try {
    const { ticketTimeType, vehicleType, days, weeks, months } = createTicketRegistrationForDayDto;
    const ticket = manager.getRepository(TicketRegistrationForDay).create(createTicketRegistrationForDayDto);
    ticket.entryOperatorName = userId ? await this.operatorName(userId, manager) : null;

    let time = '';
    if (ticketTimeType === 'DIA') {
      time = `${days} día/s`;
    } else if (ticketTimeType === 'SEMANA') {
      time = `${weeks} semana/s`;
    } else if (ticketTimeType === 'MES') {
      time = `${months} mes/es`;
    } else if (ticketTimeType === 'SEMANA_Y_DIA') {
      time = `${weeks} semana/s y ${days} día/s`;
    } else if (ticketTimeType === 'MES_Y_DIA') {
      time = `${months} mes/es y ${days} día/s`;
    }

    ticket.description = `Tipo: ${vehicleType}, ${this.ticketTimeTypeLabel[ticketTimeType]}, Tiempo: ${time}`;

    const argentinaTime = dayjs().tz('America/Argentina/Buenos_Aires').startOf('day');
    const now = argentinaTime.format('YYYY-MM-DD');
    ticket.dateNow = now;

    if (ticketTimeType === 'DIA' || ticketTimeType === 'SEMANA' || ticketTimeType === 'MES') {
      const ticketPrice = await this.getTicketTimePriceOrThrow(ticketTimeType, vehicleType);
      const qty = ticketTimeType === 'DIA' ? days : ticketTimeType === 'MES' ? months : weeks;
      ticket.price = ticketPrice.ticketTimePrice * qty;
    } else if (ticketTimeType === 'SEMANA_Y_DIA') {
      const semanaPrice = await this.getTicketTimePriceOrThrow('SEMANA', vehicleType);
      const diaPrice = await this.getTicketTimePriceOrThrow('DIA', vehicleType);
      ticket.price = semanaPrice.ticketTimePrice * (weeks ?? 0) + diaPrice.ticketTimePrice * (days ?? 0);
    } else if (ticketTimeType === 'MES_Y_DIA') {
      const mesPrice = await this.getTicketTimePriceOrThrow('MES', vehicleType);
      const diaPrice = await this.getTicketTimePriceOrThrow('DIA', vehicleType);
      ticket.price = mesPrice.ticketTimePrice * (months ?? 0) + diaPrice.ticketTimePrice * (days ?? 0);
    }

    // La caja solo se toca si el abono se cobra en el momento: si queda pendiente de pago, el
    // registro existe pero no suma nada a la planilla del día hasta que se marque pagado.
    const cash = createTicketRegistrationForDayDto.paid && this.esEfectivoDeAbono(createTicketRegistrationForDayDto.paymentMetodo) ? ticket.price : 0;
    const boxList = await this.boxListsService.applyTicketPayment(now, cash, manager, undefined, userId);

    ticket.boxList = { id: boxList.id } as BoxList;
    ticket.paymentOperatorName = ticket.paid && userId ? await this.operatorName(userId, manager) : null;

    const savedTicket = await manager.getRepository(TicketRegistrationForDay).save(ticket);
    if (ticket.paid) await recordDigital(manager, ticket.price, ticket.paymentMetodo, 'Abono ' + savedTicket.id, userId);
    return savedTicket;
  } catch (error: any) {
    if (!(error instanceof NotFoundException)) {
      this.logger.error(error.message, error.stack);
    }
    throw error;
  }
  });
}

/**
 * Qué parte de un abono entra a la caja física.
 *
 * Se define por exclusión y no como `=== 'CASH'` a propósito: los abonos viejos se guardaron sin
 * medio de pago y siempre contaron como efectivo. Cambiar ese criterio ahora movería el saldo de
 * cajas ya cerradas. Lo único que hace falta es que los medios nuevos no se cuenten como plata en
 * el cajón.
 */
private esEfectivoDeAbono(metodo?: string | null) {
  return metodo !== 'TRANSFER' && metodo !== 'MERCADOPAGO';
}

/** Un abono puntual. Lo necesita el cobro con QR para saber cuánto cobrar. */
async getRegistrationForDay(id: string) {
  return this.ticketRegistrationForDayRepository.findOne({ where: { id } });
}

// El DTO de la ruta sólo acepta CASH y TRANSFER: MERCADOPAGO no se elige a mano, lo escribe la
// acreditación automática del cobro con QR llamando a este método.
async updateTicketStatus(id: string, dto: Omit<UpdateTicketStatusDto, 'paymentMetodo'> & { paymentMetodo?: 'CASH' | 'TRANSFER' | 'MERCADOPAGO' }, userId?: string) {
    return this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const repo = manager.getRepository(TicketRegistrationForDay);
      const ticket = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!ticket) throw new NotFoundException('Abono no encontrado');
      const before = ticket.paid && this.esEfectivoDeAbono(ticket.paymentMetodo) ? ticket.price : 0;
      const paid = dto.paid ?? ticket.paid;
      const method = dto.paymentMetodo ?? ticket.paymentMetodo;
      const after = paid && this.esEfectivoDeAbono(method) ? ticket.price : 0;
      if (before !== after || paid !== ticket.paid) {
        const date = dayjs().tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD');
        const box = await this.boxListsService.applyTicketPayment(date, after - before, manager);
        ticket.boxList = { id: box.id } as BoxList;
      }
      if (ticket.paid && (!paid || method !== ticket.paymentMetodo)) await reverseDigital(manager, ticket.price, ticket.paymentMetodo, 'Abono ' + id, 'Corrección abono ' + id, userId);
      if (paid && (!ticket.paid || method !== ticket.paymentMetodo)) await recordDigital(manager, ticket.price, method, 'Abono ' + id, userId);
      if (paid && (!ticket.paid || method !== ticket.paymentMetodo)) ticket.paymentOperatorName = userId ? await this.operatorName(userId, manager) : null;
      ticket.paid = paid;
      ticket.paymentMetodo = method;
      if (dto.retired !== undefined) {
        if (dto.retired && !ticket.retired) {
          ticket.exitTurnoId = (await operatorShift(manager, userId))?.id ?? null;
          ticket.retiredAt = new Date();
          ticket.exitOperatorName = userId ? await this.operatorName(userId, manager) : null;
        }
        if (!dto.retired) {
          ticket.exitTurnoId = null;
          ticket.retiredAt = null;
          ticket.exitOperatorName = null;
        }
        ticket.retired = dto.retired;
      }
      return repo.save(ticket);
    });
  }

  // Limpieza masiva del panel "Día/Sem/Mes": solo marca `retired` (los saca de la lista de
  // ocupación), nunca toca `paid` / la caja — eso es una acción separada e independiente.
  async retireRegistrationsForDay(ids: string[], userId?: string) {
    if (!ids || ids.length === 0) {
      return { affected: 0 };
    }
    return this.dataSource.transaction(async manager => {
      const shift = await operatorShift(manager, userId);
      const exitOperatorName = userId ? await this.operatorName(userId, manager) : null;
      const result = await manager.getRepository(TicketRegistrationForDay).createQueryBuilder().update()
        .set({ retired: true, retiredAt: new Date(), exitOperatorName, exitTurnoId: shift?.id ?? null })
        .where('id IN (:...ids)', { ids }).andWhere('(retired IS NULL OR retired = false)').execute();
      return { affected: result.affected ?? 0 };
    });
  }

    async findAllRegistrationForDay(pagination?: ListPagination, operation = false) {
      try {
        const query = this.ticketRegistrationForDayRepository.createQueryBuilder('r').leftJoinAndSelect('r.boxList', 'box');
        if (operation) query.where('r.retired = false');
        query.orderBy('r.createdAt', 'DESC').addOrderBy('r.id', 'DESC');
        if (!pagination) return query.getMany();
        const [data, total] = await query.skip((pagination.page - 1) * pagination.limit).take(pagination.limit).getManyAndCount();
        return listResult(data, total, pagination);
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

    async getTicketRegistrationForDaysSummary(from?: string, to?: string) {
      try {
        const defaults = this.getDefaultRange();
        const rangeFrom = from ?? defaults.from;
        const rangeTo = to ?? defaults.to;

        const rows = await this.ticketRegistrationForDayRepository
          .createQueryBuilder('r')
          .select('r.vehicleType', 'vehicleType')
          .addSelect('r.ticketTimeType', 'ticketTimeType')
          .addSelect('COUNT(*)', 'count')
          .addSelect('SUM(r.price)', 'total')
          .where('r.dateNow BETWEEN :from AND :to', { from: rangeFrom, to: rangeTo })
          .groupBy('r.vehicleType')
          .addGroupBy('r.ticketTimeType')
          .getRawMany();

        return {
          from: rangeFrom,
          to: rangeTo,
          byVehicleTypeAndTimeType: rows.map((r) => ({
            vehicleType: r.vehicleType as string,
            ticketTimeType: r.ticketTimeType as string | null,
            count: Number(r.count),
            total: Number(r.total),
          })),
        };
      } catch (error: any) {
        this.logger.error(error.message, error.stack);
        throw error;
      }
    }

  async removeRegistrationForDay(id: string) {
    return this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const repo = manager.getRepository(TicketRegistrationForDay);
      const ticket = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!ticket) throw new NotFoundException('Abono no encontrado');
      if (ticket.paid && this.esEfectivoDeAbono(ticket.paymentMetodo)) {
        const date = dayjs().tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD');
        await this.boxListsService.applyTicketPayment(date, -ticket.price, manager);
      }
      if (ticket.paid && !this.esEfectivoDeAbono(ticket.paymentMetodo)) await reverseDigital(manager, ticket.price, ticket.paymentMetodo, 'Abono ' + id, 'Eliminación abono ' + id);
      await repo.remove(ticket);
      return { message: 'Abono eliminado.' };
    });
  }

async createPriceBracket(dto: CreateTicketPriceBracketDto) {
  await this.assertVehicleType(dto.vehicleType);
  return this.dataSource.transaction(async manager => {
    await manager.query('SELECT pg_advisory_xact_lock(718903)');
    const repository = manager.getRepository(TicketPriceBracket);
    const bracket = repository.create({ ...dto, uptoMinutes: dto.uptoMinutes ?? null, ticketDayType: dto.ticketDayType ?? null, recurringUnitMinutes: dto.recurringUnitMinutes ?? null, recurringPriceMode: dto.recurringPriceMode ?? 'FIXED' });
    validateBracket(bracket, await repository.find());
    return repository.save(bracket);
  });
}

async addAdvancePayment(id: string, dto: AdvancePaymentTicketRegistrationDto, usuarioId: string) {
  const saved = await this.dataSource.transaction(async manager => {
    const repository = manager.getRepository(TicketRegistration);
    const registration = await repository.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!registration) throw new NotFoundException('Registro no encontrado.');
    if (registration.departureTime) throw new BadRequestException('El ticket ya está cerrado.');
    const collected = await this.collectedAmount(registration, manager);
    if (dto.chargeFullPlannedStay && dto.advancePaidAmount !== undefined) {
      throw new BadRequestException('El importe de la tarifa se calcula automáticamente.');
    }
    const planned = dto.chargeFullPlannedStay
      ? await this.plannedPriceForRegistration(registration, dto.expectedUptoMinutes, manager)
      : null;
    const target = planned?.price ?? dto.advancePaidAmount ?? collected;
    if (planned && target < collected) {
      throw new BadRequestException('Ya se cobró más que esta tarifa. Elegí otra duración o gestioná la devolución por separado.');
    }
    const delta = target - collected;
    if (delta !== 0) {
      if (!dto.metodo) throw new BadRequestException('Elegí el medio de pago o devolución.');
      if (delta < 0 && !dto.adjustmentReason?.trim()) throw new BadRequestException('Para reducir un anticipo, ingresá el motivo de la devolución.');
      await this.movimientosService.create({ ticketRegistrationId: id, monto: delta, metodo: dto.metodo, tipo: delta > 0 ? 'ANTICIPO' : 'AJUSTE', motivo: dto.adjustmentReason, usuarioId }, manager);
      await this.linkToTodaysBoxList(registration, dto.metodo === 'CASH' ? delta : 0, manager, usuarioId);
    }
    registration.advancePaidAmount = target;
    if (dto.firstNameCustomer !== undefined) registration.firstNameCustomer = dto.firstNameCustomer;
    if (dto.lastNameCustomer !== undefined) registration.lastNameCustomer = dto.lastNameCustomer;
    if (dto.vehiclePlateCustomer !== undefined) registration.vehiclePlateCustomer = dto.vehiclePlateCustomer;
    if (dto.expectedBracketLabel !== undefined) registration.expectedBracketLabel = dto.expectedBracketLabel;
    if (dto.expectedUptoMinutes !== undefined) registration.expectedUptoMinutes = dto.expectedUptoMinutes;
    await repository.save(registration);
    return repository.findOne({ where: { id }, relations: ['ticket'] });
  });
  this.ticketGateway.emitNewRegistration(saved);
  return saved;
}

  private async plannedPriceForRegistration(registration: TicketRegistration, minutes?: number | null, manager?: EntityManager) {
    if (!Number.isInteger(minutes) || minutes! < 1 || minutes! > 5256000) {
      throw new BadRequestException('Elegí una duración válida para calcular la tarifa.');
    }
    if (!registration.entryDay || !registration.entryTime) throw new BadRequestException('El registro no tiene fecha de entrada.');
    const vehicle = registration.vehicleType ?? registration.ticket?.vehicleType;
    if (!vehicle) throw new BadRequestException('El registro no tiene tipo de vehículo.');
    const snapshot = registration.pricingSnapshot ?? await this.capturePricing(vehicle, manager, false);
    const entry = dayjs.tz(`${registration.entryDay} ${registration.entryTime}`, 'YYYY-MM-DD HH:mm:ss', 'America/Argentina/Buenos_Aires');
    if (!entry.isValid()) throw new BadRequestException('La fecha de entrada no es válida.');
    return calculateStayPrice(snapshot, vehicle, entry.toDate(), entry.add(minutes!, 'minute').toDate());
  }

  async previewPlannedPrice(id: string, minutes: number) {
    const registration = await this.ticketRegistrationRepository.findOne({ where: { id }, relations: ['ticket'] });
    if (!registration) throw new NotFoundException('Registro no encontrado.');
    if (registration.departureTime) throw new BadRequestException('El ticket ya está cerrado.');
    const result = await this.plannedPriceForRegistration(registration, minutes);
    return { price: result.price, ticketDayType: result.ticketDayType };
  }

/**
 * Registra en la estadía un pago que se cobró por fuera del mostrador (hoy, el QR de MercadoPago
 * ya acreditado). Igual que una transferencia al alias: entra como un pago más y, si con eso no
 * queda saldo, la salida se registra en la misma transacción, así el cajero no tiene que tocar
 * nada más. La estadía se cobra hasta la hora en que el cajero pidió el pago (ver acreditarPagoEn).
 *
 * `referencia` guarda el id del pago en MercadoPago: es el rastro que permite reconciliar una
 * fila del libro con un pago real.
 */
async registrarPagoExterno(
  registrationId: string,
  monto: number,
  metodo: MovimientoMetodo,
  referencia: string,
  usuarioId: string,
) {
  const r = await this.dataSource.transaction(manager => this.acreditarPagoEn(manager, registrationId, monto, metodo, referencia, usuarioId));
  if (r.yaCerrada) throw new BadRequestException('El ticket ya está cerrado.');
  this.ticketGateway.emitNewRegistration(r.registration);
  return { cerrada: r.cerrada, saldoPendiente: r.saldoPendiente };
}

async findAllPriceBrackets(vehicleType?: string) {
  try {
    return await this.ticketPriceBracketRepository.find({
      where: vehicleType ? { vehicleType: vehicleType as any } : {},
      order: { vehicleType: 'ASC', uptoMinutes: 'ASC' },
    });
  } catch (error: any) {
    this.logger.error(error.message, error.stack);
    throw error;
  }
}

async updatePriceBracket(id: string, dto: UpdateTicketPriceBracketDto) {
  if (dto.vehicleType) await this.assertVehicleType(dto.vehicleType);
  return this.dataSource.transaction(async manager => {
    await manager.query('SELECT pg_advisory_xact_lock(718903)');
    const repository = manager.getRepository(TicketPriceBracket);
    const bracket = await repository.findOne({ where: { id } });
    if (!bracket) throw new NotFoundException('Franja de precio no encontrada.');
    const updated = repository.merge(bracket, dto);
    validateBracket(updated, await repository.find());
    return repository.save(updated);
  });
}

async removePriceBracket(id: string) {
  return this.dataSource.transaction(async manager => {
    await manager.query('SELECT pg_advisory_xact_lock(718903)');
    const result = await manager.getRepository(TicketPriceBracket).delete(id);
    if (!result.affected) throw new NotFoundException('Franja de precio no encontrada.');
    return { message: 'Franja de precio eliminada correctamente' };
  });
}

  async findAllRegistrations(pagination?: ListPagination, operation = false) {
    try{
        const query = this.ticketRegistrationRepository.createQueryBuilder('r').leftJoinAndSelect('r.ticket', 'ticket').leftJoinAndSelect('r.boxList', 'box');
        // Además de los que están adentro, los últimos 4 que cambiaron: son los que muestra
        // «Últimos movimientos» al abrir la pantalla, salidas incluidas.
        if (operation) query.where('r.departureTime IS NULL OR r.id IN (SELECT id FROM ticket_registrations ORDER BY "updatedAt" DESC, id DESC LIMIT 4)');
        query.orderBy('r.createdAt', 'DESC').addOrderBy('r.id', 'DESC');
        if (!pagination) return query.getMany();
        const [data, total] = await query.skip((pagination.page - 1) * pagination.limit).take(pagination.limit).getManyAndCount();
        return listResult(data, total, pagination);
    } catch (error: any) {
        this.logger.error(error.message, error.stack);
    }
  }

  async receiptHistory(pagination: ListPagination, date: string, search = '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !dayjs(date).isValid() || dayjs(date).format('YYYY-MM-DD') !== date) throw new BadRequestException('Fecha inválida.');
    const union = `
      SELECT id, COALESCE(NULLIF("licensePlateOriginal", ''), NULLIF("vehiclePlateCustomer", ''), NULLIF("codeBarTicket", ''), "lastNameCustomer", 'Sin patente') AS identification,
        CONCAT_WS(' ', "licensePlateOriginal", "vehiclePlateCustomer", "codeBarTicket", "lastNameCustomer") AS search,
        COALESCE("departureDay", "entryDay")::text AS date,
        COALESCE("departureTime"::text, "entryTime"::text, '') AS time,
        ("departureTime" IS NOT NULL OR "departureDay" IS NOT NULL) AS departed, 'Por hora' AS type,
        "entryOperatorName", "exitOperatorName"
      FROM ticket_registrations WHERE "entryDay" = $1 OR "departureDay" = $1
      UNION ALL
      SELECT id, COALESCE(NULLIF("vehiclePlateCustomer", ''), "lastNameCustomer", 'Sin patente'),
        CONCAT_WS(' ', "vehiclePlateCustomer", "lastNameCustomer"),
        COALESCE(to_char("retiredAt" AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD'), "dateNow"::text),
        COALESCE(to_char("retiredAt" AT TIME ZONE 'America/Argentina/Buenos_Aires', 'HH24:MI:SS'), ''), retired, 'Día / semana / mes',
        "entryOperatorName", "exitOperatorName"
      FROM ticket_registration_for_days WHERE "dateNow" = $1 OR ("retiredAt" >= ($1::date::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires') AND "retiredAt" < (($1::date + 1)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires'))`;
    const filtered = `WITH rows AS (${union}) SELECT * FROM rows WHERE regexp_replace(upper(search), '[^A-Z0-9]', '', 'g') LIKE $2`;
    const searchKey = search.slice(0, 120).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const params = [date, '%' + searchKey + '%'];
    const [count] = await this.dataSource.query(`SELECT COUNT(*) AS total FROM (${filtered}) filtered`, params);
    const data = await this.dataSource.query(`${filtered} ORDER BY date DESC, time DESC, id DESC LIMIT $3 OFFSET $4`, [...params, pagination.limit, (pagination.page - 1) * pagination.limit]);
    return listResult(data, Number(count.total), pagination);
  }

  async getTicketRegistrationsSummary(from?: string, to?: string) {
    try {
      const defaults = this.getDefaultRange();
      const rangeFrom = from ?? defaults.from;
      const rangeTo = to ?? defaults.to;

      const rows = await this.ticketRegistrationRepository
        .createQueryBuilder('reg')
        .leftJoin('reg.ticket', 'ticket')
        .select('ticket.vehicleType', 'vehicleType')
        .addSelect('COUNT(*)', 'count')
        .addSelect('SUM(reg.price)', 'total')
        .where('reg.entryDay BETWEEN :from AND :to', { from: rangeFrom, to: rangeTo })
        .groupBy('ticket.vehicleType')
        .getRawMany();

      return {
        from: rangeFrom,
        to: rangeTo,
        byVehicleType: rows.map((r) => ({
          vehicleType: r.vehicleType as string | null,
          count: Number(r.count),
          total: Number(r.total),
        })),
      };
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
      throw error;
    }
  }

  // Actividad por hora de un día puntual — cada entrada y cada salida suma 1 a la hora en la
  // que ocurrió, para poder graficar los picos de movimiento (mañana/tarde) del día.
  async getHourlyActivity(date?: string) {
    try {
      const targetDate = date ?? dayjs().tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD');

      // TO_CHAR fuerza que entryDay/departureDay vuelvan como texto plano ('YYYY-MM-DD') — en
      // una query raw, columnas `date` de Postgres vuelven como objeto Date de JS, no string, y
      // comparar ese objeto contra targetDate con === nunca daba true (el bug que hacía que esto
      // devolviera todo en cero pese a haber datos reales para el día).
      const rows = await this.ticketRegistrationRepository
        .createQueryBuilder('reg')
        .select(`TO_CHAR(reg."entryDay", 'YYYY-MM-DD')`, 'entryDay')
        .addSelect('reg.entryTime', 'entryTime')
        .addSelect(`TO_CHAR(reg."departureDay", 'YYYY-MM-DD')`, 'departureDay')
        .addSelect('reg.departureTime', 'departureTime')
        .where('reg.entryDay = :date OR reg.departureDay = :date', { date: targetDate })
        .getRawMany();

      const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, entries: 0, exits: 0, count: 0 }));

      // El gráfico agrupa por hora para que la curva quede legible, pero el pico tiene que
      // mostrar el minuto real del evento (ej. 19:14), no la hora redondeada — acá se guarda el
      // horario exacto de cada entrada/salida para poder recuperarlo después.
      let peakEntry: { hour: number; count: number; time: string } | null = null;
      let peakExit: { hour: number; count: number; time: string } | null = null;

      for (const r of rows) {
        if (r.entryDay === targetDate && r.entryTime) {
          const h = Number(String(r.entryTime).slice(0, 2));
          if (h >= 0 && h < 24) {
            hours[h].entries += 1;
            hours[h].count += 1;
            if (!peakEntry || hours[h].entries > peakEntry.count) {
              peakEntry = { hour: h, count: hours[h].entries, time: String(r.entryTime) };
            }
          }
        }
        if (r.departureDay === targetDate && r.departureTime) {
          const h = Number(String(r.departureTime).slice(0, 2));
          if (h >= 0 && h < 24) {
            hours[h].exits += 1;
            hours[h].count += 1;
            if (!peakExit || hours[h].exits > peakExit.count) {
              peakExit = { hour: h, count: hours[h].exits, time: String(r.departureTime) };
            }
          }
        }
      }

      return { date: targetDate, hours, peakEntry, peakExit };
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
      throw error;
    }
  }

  async findOneRegistration(id: string) {
    try{
        const registration = await this.ticketRegistrationRepository.findOne({where:{id:id}})
        if(!registration){
            throw new NotFoundException('Registration not found')
        }
        return registration;
    } catch (error: any) {
        if (!(error instanceof NotFoundException)) {
          this.logger.error(error.message, error.stack);
        }
        throw error;
      }
  }

  // ────────────────────────────────────────────────────────────────────────────────────────
  // Flujo nuevo por patente — independiente del flujo por código de barras de arriba, que
  // sigue funcionando exactamente igual (escanear entra, escanear sale, sin pedir medio de
  // pago). Estos registros nunca tienen `ticket` poblado.
  // ────────────────────────────────────────────────────────────────────────────────────────

  private minutesSinceEntry(entryDay: string, entryTime: string): number {
    const entryAt = dayjs.tz(`${entryDay} ${entryTime}`, 'YYYY-MM-DD HH:mm:ss', 'America/Argentina/Buenos_Aires');
    if (!entryAt.isValid()) {
      throw new BadRequestException('Invalid entryDay/entryTime');
    }
    const now = dayjs().tz('America/Argentina/Buenos_Aires');
    return now.diff(entryAt, 'minute');
  }

  async createRegistrationByPlate(dto: CreateRegistrationByPlateDto, userId?: string) {
    const saved = await this.dataSource.transaction(async manager => {
      const repository = manager.getRepository(TicketRegistration);
      if (dto.noPlate && !dto.lastNameCustomer?.trim()) {
        throw new BadRequestException('El apellido es obligatorio cuando no hay patente.');
      }
      if (!dto.noPlate && !dto.licensePlate?.trim()) {
        throw new BadRequestException('La patente es obligatoria.');
      }

      let licensePlateOriginal: string | null = null;
      let licensePlateNormalized: string | null = null;
      let licensePlateSearch: string | null = null;
      let duplicateOfRegistrationId: string | null = null;

      if (!dto.noPlate) {
        licensePlateOriginal = dto.licensePlate!.trim();
        licensePlateNormalized = normalizePlate(licensePlateOriginal);
        licensePlateSearch = toSearchKey(licensePlateNormalized);

        if (!licensePlateNormalized) throw new BadRequestException('La patente debe contener letras o números.');
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`plate:${licensePlateNormalized}`]);
        const existing = await repository.findOne({
          where: { licensePlateNormalized, departureTime: IsNull() },
        });

        if (existing && !(dto.duplicateOverride && dto.duplicateOverrideReason?.trim())) {
          throw new BadRequestException({
            code: 'DUPLICATE_ACTIVE_PLATE',
            message: `Ya hay un ingreso activo para ${licensePlateOriginal} desde las ${existing.entryTime}`,
            existingRegistrationId: existing.id,
            entryTime: existing.entryTime,
          });
        }

        if (existing) {
          duplicateOfRegistrationId = existing.id;
        }
      }

      const pricingSnapshot = await this.capturePricing(dto.vehicleType, manager);
      const entryOperatorName = userId ? await this.operatorName(userId, manager) : null;
      const argentinaTime = dayjs(pricingSnapshot.capturedAt).tz('America/Argentina/Buenos_Aires');
      const registration = repository.create({
        entryOperatorName,
        pricingSnapshot, entryMode: 'PLATE',
        description: `Registro por patente para vehículo tipo ${dto.vehicleType}`,
        price: 0,
        entryDay: argentinaTime.format('YYYY-MM-DD'),
        entryTime: argentinaTime.format('HH:mm:ss'),
        departureDay: null,
        departureTime: null,
        dateNow: null,
        vehicleType: dto.vehicleType,
        licensePlateOriginal,
        licensePlateNormalized,
        licensePlateSearch,
        casilleroNumber: dto.casilleroNumber ?? null,
        lastNameCustomer: dto.lastNameCustomer ?? null,
        phoneCustomer: dto.phoneCustomer?.trim().replace(/[\s()+-]/g, '') || null,
        noPlate: !!dto.noPlate,
        duplicatePlateOverrideReason: dto.duplicateOverride ? dto.duplicateOverrideReason ?? null : null,
        duplicateOfRegistrationId,
      });

      const created = await repository.save(registration);
      await publishAutomaticNote(manager, { sourceKey: `entrada:${created.id}`, origin: 'Entrada con patente ya activa', sourceType: 'TICKET', sourceId: created.id, usuarioId: userId, description: created.duplicatePlateOverrideReason, context: created.licensePlateOriginal ?? created.id });
      return created;
    });
    this.ticketGateway.emitNewRegistration(saved);
    return saved;
  }

  // Coincidencia exacta para dirigir el escaneo: la búsqueda aproximada puede devolver otra
  // patente (O/0, I/1) y nunca debe decidir qué estadía cobrar.
  async getPlateStatus(rawPlate: string) {
    const plate = normalizePlate(rawPlate ?? '');
    if (!plate || plate.length > 50) throw new BadRequestException('La patente no es válida.');
    const hourly = await this.ticketRegistrationRepository.createQueryBuilder('r')
      .leftJoinAndSelect('r.ticket', 'ticket')
      .where("(r.licensePlateNormalized = :plate OR (r.licensePlateNormalized IS NULL AND regexp_replace(UPPER(COALESCE(NULLIF(r.licensePlateOriginal, ''), r.vehiclePlateCustomer, '')), '[^A-Z0-9]', '', 'g') = :plate))", { plate })
      .andWhere('r.departureTime IS NULL')
      .orderBy('r.entryDay', 'ASC').addOrderBy('r.entryTime', 'ASC').getMany();
    const daily = await this.ticketRegistrationForDayRepository.createQueryBuilder('r')
      .where('COALESCE(r.retired, false) = false')
      .andWhere("regexp_replace(UPPER(COALESCE(r.vehiclePlateCustomer, '')), '[^A-Z0-9]', '', 'g') = :plate", { plate })
      .orderBy('r.createdAt', 'ASC').getMany();
    // Sin coincidencia exacta, los de adentro con una patente a un carácter de distancia: el auto
    // puede ser uno de ellos mal leído al entrar o al salir. Las pantallas los ofrecen antes de
    // registrar una entrada nueva.
    const similares = hourly.length || daily.length ? [] : (await this.ticketRegistrationRepository.find({ where: { departureTime: IsNull() }, relations: ['ticket'] }))
      .filter((r) => !!r.licensePlateNormalized && patentesParecidas(plate, r.licensePlateNormalized))
      .sort((a, b) => `${a.entryDay} ${a.entryTime}`.localeCompare(`${b.entryDay} ${b.entryTime}`))
      .slice(0, 5);
    return { plate, hourly, daily, similares };
  }

  async searchActiveRegistrations(q: string) {
    const query = (q ?? '').trim();

    const qb = this.ticketRegistrationRepository
      .createQueryBuilder('r')
      // Sin este join, los registros por código de barras vuelven con `r.ticket` sin cargar
      // y el frontend los confunde con registros por patente (icono y etiqueta equivocados).
      .leftJoinAndSelect('r.ticket', 'ticket')
      .where('r.departureTime IS NULL');

    // Sin texto (o muy corto) devuelve todos los activos, no una lista vacía — el buscador
    // arranca poblado y el texto solo lo va acotando.
    if (query.length >= 3) {
      const plateKey = toSearchKey(normalizePlate(query));
      const raw = query.toUpperCase();
      qb.andWhere(
        new Brackets((qb2) => {
          qb2
            .where('r.licensePlateSearch ILIKE :plateKey', { plateKey: `%${plateKey}%` })
            .orWhere('r.casilleroNumber ILIKE :raw', { raw: `%${raw}%` })
            .orWhere('r.lastNameCustomer ILIKE :raw', { raw: `%${raw}%` })
            .orWhere('ticket.codeBar ILIKE :raw', { raw: `%${raw}%` });
        }),
      );
    }

    const coinciden = await qb.orderBy('r.entryDay', 'ASC').addOrderBy('r.entryTime', 'ASC').getMany();
    // Después de las que coinciden, las de adentro con una patente parecida (1 o 2 caracteres
    // distintos), marcadas `parecida`: lo escaneado o escrito puede ser ese auto mal leído al
    // entrar o al salir, como el «¿Es alguno de estos?» del escaneo.
    if (toSearchKey(normalizePlate(query)).length < 5) return coinciden;
    const ya = new Set(coinciden.map((r) => r.id));
    const parecidas = (await this.ticketRegistrationRepository.find({ where: { departureTime: IsNull() }, relations: ['ticket'] }))
      .filter((r) => !ya.has(r.id) && !!r.licensePlateNormalized && patentesParecidas(query, r.licensePlateNormalized))
      .sort((a, b) => `${a.entryDay} ${a.entryTime}`.localeCompare(`${b.entryDay} ${b.entryTime}`))
      .slice(0, 5);
    return [...coinciden, ...parecidas.map((r) => Object.assign(r, { parecida: true }))];
  }

  async collectedAmount(registration: TicketRegistration, manager?: EntityManager) {
    const amount = await this.movimientosService.sumByRegistration(registration.id, manager);
    if (registration.pricingSnapshot) return amount;
    registration.legacyCollectedOffset ??= Math.max(0, (registration.advancePaidAmount ?? 0) - amount);
    return amount + registration.legacyCollectedOffset;
  }

  async getCloseSummary(id: string, manager?: EntityManager) {
    const registration = await (manager ? manager.getRepository(TicketRegistration) : this.ticketRegistrationRepository).findOne({ where: { id }, relations: ['ticket'] });
    if (!registration) throw new NotFoundException('Registro no encontrado.');
    if (registration.departureTime) throw new BadRequestException('Este ticket ya está cerrado.');
    const preview = await this.priceRegistration(registration, manager);
    const totalCollectedSoFar = await this.collectedAmount(registration, manager);
    const saldoACobrar = Math.max(0, preview.price - totalCollectedSoFar);
    return { registration, elapsedMinutes: preview.elapsedMinutes, previewBracket: preview,
      totalCollectedSoFar, saldoACobrar,
      cambioARetornar: Math.max(0, totalCollectedSoFar - preview.price),
      tarifaAnterior: await this.tarifaAnterior(registration, preview, saldoACobrar, manager),
      pricingDayType: preview.ticketDayType, pricingDayTypeBasis: preview.pricingDayTypeBasis, tariffSnapshotUsed: preview.tariffSnapshotUsed };
  }

  /**
   * El escalón anterior al que corresponde ahora y el descuento que deja la estadía en ese precio.
   * Es para cuando el cliente pagó tarde (cerró la espera del alias o del QR, tardó en transferir)
   * y la estadía pasó de escalón mientras tanto: el cajero cobra lo que le había dicho con un
   * descuento justificado, sin hacer la cuenta a mano. Se busca con el mismo cálculo del cobro el
   * último minuto en que la estadía costaba menos. null si ya está en el primer escalón o si no
   * queda saldo que descontar.
   */
  private async tarifaAnterior(registration: TicketRegistration, preview: Awaited<ReturnType<TicketsService['priceRegistration']>>, saldo: number, manager?: EntityManager) {
    if (saldo <= 0) return null;
    const vehicle = registration.vehicleType ?? registration.ticket?.vehicleType;
    if (!vehicle) return null;
    const snapshot = registration.pricingSnapshot ?? await this.capturePricing(vehicle, manager, false);
    const entry = dayjs.tz(`${registration.entryDay} ${registration.entryTime}`, 'YYYY-MM-DD HH:mm:ss', 'America/Argentina/Buenos_Aires');
    const bruto = preview.price + preview.descuentoTotal;
    const calcular = (minutos: number) => calculateStayPrice(snapshot, vehicle, entry.toDate(), entry.add(minutos, 'minute').toDate());
    let menor = 0;
    let mayor = Math.max(0, Math.floor(preview.elapsedMinutes));
    if (calcular(menor).price >= bruto) return null;
    while (mayor - menor > 1) {
      const medio = Math.floor((menor + mayor) / 2);
      if (calcular(medio).price < bruto) menor = medio; else mayor = medio;
    }
    const anterior = calcular(menor);
    const descuento = Math.min(saldo, preview.price - anterior.price);
    if (descuento <= 0) return null;
    return { precio: anterior.price, etiqueta: anterior.label, hastaMinutos: menor, descuento };
  }

  // Un importe negativo acá es siempre plata de un anticipo que se devuelve en efectivo (sobró al
  // cerrar, o se redujo el anticipo): va con su propia categoría para que el resumen del turno la
  // descuente de lo cobrado en efectivo y no la muestre como un retiro de caja.
  private async linkToTodaysBoxList(registration: TicketRegistration, amount: number, manager: EntityManager, usuarioId?: string) {
    const date = dayjs().tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD');
    const box = await this.boxListsService.applyTicketPayment(date, amount, manager, undefined, usuarioId, amount < 0 ? 'DEVOLUCION_ANTICIPO' : 'COBRO');
    registration.dateNow = date;
    registration.boxList = { id: box.id } as BoxList;
  }

  async discountRegistration(id: string, dto: DiscountRegistrationDto, usuarioId: string) {
    const result = await this.dataSource.transaction(async manager => {
      const repo = manager.getRepository(TicketRegistration);
      const registration = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!registration) throw new NotFoundException('Registro no encontrado.');
      if (registration.departureTime) throw new BadRequestException('Este ticket ya está cerrado.');
      const summary = await this.getCloseSummary(id, manager);
      if (summary.previewBracket.price !== dto.expectedPrice || summary.totalCollectedSoFar !== dto.expectedCollected) {
        throw new ConflictException('El importe cambió. Revisá el resumen antes de aplicar el descuento.');
      }
      if (!Number.isInteger(dto.monto) || dto.monto <= 0 || dto.monto > summary.saldoACobrar) {
        throw new BadRequestException('El descuento debe ser mayor a cero y no superar el saldo pendiente.');
      }
      if (!dto.motivo?.trim() || dto.motivo.trim().length > 255) throw new BadRequestException('Ingresá el motivo del descuento.');
      const [pending] = await manager.query(`SELECT EXISTS (
        SELECT 1 FROM cobros_mercadopago WHERE "registrationId"=$1 AND tipo='HORA' AND estado='PENDIENTE'
        UNION ALL SELECT 1 FROM cobros_transferencia WHERE "registrationId"=$1 AND tipo='HORA' AND estado IN ('ESPERANDO','REVISION')
      ) AS present`, [id]);
      if (pending.present) throw new ConflictException('Cancelá el cobro pendiente antes de aplicar un descuento.');
      await this.movimientosService.create({ ticketRegistrationId: id, monto: dto.monto, metodo: 'CASH', tipo: 'DESCUENTO', motivo: dto.motivo.trim(), usuarioId }, manager);
      // El descuento no es un cobro ni una devolución: se conserva en el libro sin mover efectivo.
      await this.linkToTodaysBoxList(registration, 0, manager, usuarioId);
      registration.price = summary.previewBracket.price - dto.monto;
      await repo.save(registration);
      return this.getCloseSummary(id, manager);
    });
    this.ticketGateway.emitNewRegistration(result.registration);
    return result;
  }

  /**
   * La parte en efectivo de un pago híbrido cuyo resto va por QR o alias. Esos cobros piden el
   * saldo de ese momento y, al acreditarse sin saldo, registran la salida solos; entonces se
   * registra primero el efectivo —que ya está en la mano— y el QR o el alias piden el resto.
   * Si después el QR o el alias no se pagan, el efectivo queda cobrado y el resto se cobra con
   * otro medio. El importe tiene que ser menor que el saldo: todo en efectivo es un cierre común.
   */
  async cobrarParteEnEfectivo(id: string, dto: PagoParcialDto, usuarioId: string) {
    const result = await this.dataSource.transaction(async manager => {
      const repo = manager.getRepository(TicketRegistration);
      const registration = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!registration) throw new NotFoundException('Registro no encontrado.');
      if (registration.departureTime) throw new BadRequestException('Este ticket ya está cerrado.');
      const summary = await this.getCloseSummary(id, manager);
      if (summary.previewBracket.price !== dto.expectedPrice || summary.totalCollectedSoFar !== dto.expectedCollected) {
        throw new ConflictException({ code: 'TICKET_PRICE_CHANGED', message: 'El importe cambió. Revisá el resumen actualizado antes de confirmar.' });
      }
      if (!Number.isInteger(dto.importe) || dto.importe <= 0 || dto.importe >= summary.saldoACobrar) {
        throw new BadRequestException('El efectivo tiene que ser menor que lo que falta cobrar: si cubre todo, elegí «Efectivo».');
      }
      const [pending] = await manager.query(`SELECT EXISTS (
        SELECT 1 FROM cobros_mercadopago WHERE "registrationId"=$1 AND tipo='HORA' AND estado='PENDIENTE'
        UNION ALL SELECT 1 FROM cobros_transferencia WHERE "registrationId"=$1 AND tipo='HORA' AND estado IN ('ESPERANDO','REVISION')
      ) AS present`, [id]);
      if (pending.present) throw new ConflictException('Ya hay un QR o una transferencia esperando el pago de esta estadía.');
      await this.movimientosService.create({ ticketRegistrationId: id, monto: dto.importe, metodo: 'CASH', tipo: 'SALDO', usuarioId }, manager);
      await this.linkToTodaysBoxList(registration, dto.importe, manager, usuarioId);
      await repo.save(registration);
      return this.getCloseSummary(id, manager);
    });
    this.ticketGateway.emitNewRegistration(result.registration);
    return result;
  }

  /**
   * La entrada que se cargó tarde: el operador creyó haberla registrado al llegar el vehículo y
   * la cargó recién al ir a cobrarle, así que la estadía figura con minutos y se cobraba como la
   * primera duración. El panel de cobro lo pregunta cuando la estadía tiene menos de 5 minutos.
   *
   * Para que no sirva para cobrar de menos: la hora solo se mueve hacia atrás (cobra más, nunca
   * menos), solo en una estadía abierta y recién cargada (una vez corregida deja de serlo), como
   * mucho 24 horas, y no puede pisar otra estadía de la misma patente. Queda en la Actividad de la
   * empresa con la patente, la hora que tenía y la nueva (AUDIT_RULES).
   */
  async corregirEntradaOlvidada(id: string, entradaIso: string, _usuarioId: string) {
    const TZ = 'America/Argentina/Buenos_Aires';
    const result = await this.dataSource.transaction(async manager => {
      const repo = manager.getRepository(TicketRegistration);
      const registration = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!registration) throw new NotFoundException('Registro no encontrado.');
      if (registration.departureTime) throw new BadRequestException('Este ticket ya está cerrado.');
      if (!registration.entryDay || !registration.entryTime) throw new BadRequestException('La estadía no tiene hora de entrada.');
      const ahora = dayjs().tz(TZ);
      const actual = dayjs.tz(`${registration.entryDay} ${registration.entryTime}`, 'YYYY-MM-DD HH:mm:ss', TZ);
      if (ahora.diff(actual, 'minute') > 15)
        throw new BadRequestException({ code: 'ENTRADA_NO_CORREGIBLE', message: 'Solo se puede corregir la hora de una entrada recién cargada.' });
      const nueva = dayjs(entradaIso).tz(TZ).second(0).millisecond(0);
      if (!nueva.isValid()) throw new BadRequestException('Indicá la hora en que entró.');
      if (!nueva.isBefore(actual)) throw new BadRequestException('La hora en que entró tiene que ser anterior a la que figura.');
      if (ahora.diff(nueva, 'hour', true) > 24) throw new BadRequestException('No se puede poner una entrada de hace más de 24 horas.');
      const [pending] = await manager.query(`SELECT EXISTS (
        SELECT 1 FROM cobros_mercadopago WHERE "registrationId"=$1 AND tipo='HORA' AND estado='PENDIENTE'
        UNION ALL SELECT 1 FROM cobros_transferencia WHERE "registrationId"=$1 AND tipo='HORA' AND estado IN ('ESPERANDO','REVISION')
      ) AS present`, [id]);
      if (pending.present) throw new ConflictException('Cancelá el cobro pendiente antes de corregir la entrada.');
      // Si la patente tuvo otra estadía en ese lapso (cerrada después de la hora nueva, o abierta),
      // corregir cobraría dos veces el mismo tiempo.
      if (registration.licensePlateNormalized) {
        const [solapada] = await manager.query(
          `SELECT 1 FROM ticket_registrations
           WHERE id <> $1 AND "licensePlateNormalized" = $2
             AND ("departureDay" IS NULL OR ("departureDay" + "departureTime") > $3::timestamp)
           LIMIT 1`,
          [id, registration.licensePlateNormalized, nueva.format('YYYY-MM-DD HH:mm:ss')],
        );
        if (solapada) throw new ConflictException({ code: 'ENTRADA_SOLAPADA', message: 'Esta patente tiene otra estadía en ese horario. Revisala antes de corregir.' });
      }
      registration.entryDay = nueva.format('YYYY-MM-DD');
      registration.entryTime = nueva.format('HH:mm:ss');
      await repo.save(registration);
      return {
        summary: await this.getCloseSummary(id, manager),
        // Para la Actividad (AuditInterceptor copia estos tres de la respuesta).
        patente: registration.licensePlateOriginal || registration.codeBarTicket || '',
        entradaAnterior: actual.format('DD/MM HH:mm'),
        entrada: nueva.format('DD/MM HH:mm'),
      };
    });
    this.ticketGateway.emitNewRegistration(result.summary.registration);
    return result;
  }

  /**
   * Corrige la patente o el tipo de vehículo de una estadía abierta, desde el cobro: se cargó
   * Auto y era Camioneta, o la patente con un carácter mal. Con otro tipo la estadía pasa a las
   * tarifas de ese tipo, conservando el horario y las opciones que tenía al entrar (la copia de
   * tarifas es de un solo tipo). Lo cobrado y los descuentos se conservan; el saldo se recalcula.
   * No se toca con un QR o alias esperando el pago: el importe pedido dejaría de coincidir.
   */
  async corregirDatosEstadia(id: string, dto: CorregirDatosEstadiaDto, _usuarioId: string) {
    const result = await this.dataSource.transaction(async manager => {
      const repo = manager.getRepository(TicketRegistration);
      const registration = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!registration) throw new NotFoundException('Registro no encontrado.');
      if (registration.departureTime) throw new BadRequestException('Este ticket ya está cerrado.');
      const conTicket = await repo.findOne({ where: { id }, relations: ['ticket'] });
      const tipoAnterior = registration.vehicleType ?? conTicket?.ticket?.vehicleType ?? null;
      const patenteAnterior = registration.licensePlateOriginal || null;
      const [pending] = await manager.query(`SELECT EXISTS (
        SELECT 1 FROM cobros_mercadopago WHERE "registrationId"=$1 AND tipo='HORA' AND estado='PENDIENTE'
        UNION ALL SELECT 1 FROM cobros_transferencia WHERE "registrationId"=$1 AND tipo='HORA' AND estado IN ('ESPERANDO','REVISION')
      ) AS present`, [id]);
      if (pending.present) throw new ConflictException('Cancelá el cobro pendiente antes de corregir la estadía.');

      if (dto.licensePlate !== undefined) {
        if (conTicket?.ticket || registration.entryMode === 'BARCODE') throw new BadRequestException('Es una estadía de tarjeta: no tiene patente para corregir.');
        const original = dto.licensePlate.trim().toUpperCase();
        const normalized = normalizePlate(original);
        if (!normalized) throw new BadRequestException('La patente debe contener letras o números.');
        if (normalized !== registration.licensePlateNormalized) {
          const otra = await repo.findOne({ where: { licensePlateNormalized: normalized, departureTime: IsNull() } });
          if (otra && otra.id !== id) throw new ConflictException({ code: 'DUPLICATE_ACTIVE_PLATE', message: 'Esa patente ya está adentro en otra estadía.', existingRegistrationId: otra.id });
          Object.assign(registration, { licensePlateOriginal: original, licensePlateNormalized: normalized, licensePlateSearch: toSearchKey(normalized), noPlate: false });
        }
      }

      if (dto.vehicleType && dto.vehicleType !== tipoAnterior) {
        await this.assertVehicleType(dto.vehicleType, manager);
        if (registration.pricingSnapshot) {
          await manager.query('SELECT pg_advisory_xact_lock_shared(718903)');
          const brackets = await manager.getRepository(TicketPriceBracket).find({ where: { vehicleType: dto.vehicleType as any } });
          const snapshot: PricingSnapshot = { ...registration.pricingSnapshot, brackets };
          // Que el tipo nuevo tenga precio, con la misma regla que al entrar (capturePricing).
          assertPricingCoverage(snapshot, dto.vehicleType, resolveDayType(snapshot.schedule, dayjs().tz('America/Argentina/Buenos_Aires').hour()));
          if (snapshot.schedule.pricingDayTypeBasis === 'EXIT' || snapshot.schedule.pricingOptions?.crossing.enabled) {
            assertPricingCoverage(snapshot, dto.vehicleType, 'DAY');
            assertPricingCoverage(snapshot, dto.vehicleType, 'NIGHT');
          }
          registration.pricingSnapshot = snapshot;
        }
        registration.vehicleType = dto.vehicleType as any;
      }
      await repo.save(registration);
      return {
        summary: await this.getCloseSummary(id, manager),
        // Para la Actividad (AuditInterceptor copia estos de la respuesta).
        patente: registration.licensePlateOriginal || registration.codeBarTicket || '',
        patenteAnterior,
        tipo: registration.vehicleType ?? tipoAnterior,
        tipoAnterior,
      };
    });
    this.ticketGateway.emitNewRegistration(result.summary.registration);
    return result;
  }

  // Ambas identificaciones usan una operación atómica; reintentar un cierre no vuelve a cobrar.
  async closeRegistrationByPlate(id: string, dto: CloseRegistrationDto, usuarioId: string) {
    const saved = await this.dataSource.transaction(manager => this.cerrarEnTransaccion(manager, id, dto, usuarioId));
    this.ticketGateway.emitNewRegistration(saved);
    return saved;
  }

  /**
   * Una transferencia al alias que el sistema asoció a esta estadía (VerificacionAliasService):
   * se registra como un pago más y, si con eso no queda saldo, se registra la salida, todo dentro
   * de la transacción del que llama, la misma en la que la transferencia queda marcada como usada.
   * Si la estadía ya se había cerrado por otro lado no registra nada (`yaCerrada`).
   */
  async acreditarTransferenciaEn(manager: EntityManager, id: string, monto: number, referencia: string, usuarioId: string) {
    return this.acreditarPagoEn(manager, id, monto, 'TRANSFER', referencia, usuarioId);
  }

  // El pago entra como ANTICIPO y la salida, si corresponde, como un cierre sin cobro: el libro
  // queda igual que si el cajero hubiera cobrado a mano. Pasa por linkToTodaysBoxList aunque no
  // sea efectivo —con importe 0— porque es lo que hace visible el pago en la caja y la planilla.
  //
  // El precio es el de la hora en que el cajero pidió el pago (`externalPayment.at`), no el de la
  // acreditación: el importe pedido salió de ese momento y el auto se va al pagar. Calcularlo al
  // acreditar dejaba abiertas, con saldo y sin salida, las estadías cuya transferencia llegaba
  // después de pasar de escalón, cuando el cliente ya no estaba para cobrarle la diferencia.
  private async acreditarPagoEn(manager: EntityManager, id: string, monto: number, metodo: MovimientoMetodo, referencia: string, usuarioId: string) {
    const pedidoEn = externalPayment.getStore()?.at;
    const repository = manager.getRepository(TicketRegistration);
    const registration = await repository.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!registration) throw new NotFoundException('Registro no encontrado.');
    if (registration.departureTime) return { yaCerrada: true as const };
    await this.movimientosService.create({ ticketRegistrationId: id, monto, metodo, tipo: 'ANTICIPO', referencia, usuarioId }, manager);
    await this.linkToTodaysBoxList(registration, metodo === 'CASH' ? monto : 0, manager, usuarioId);
    registration.advancePaidAmount = await this.collectedAmount(registration, manager);
    await repository.save(registration);
    const withTicket = await repository.findOne({ where: { id }, relations: ['ticket'] });
    registration.ticket = withTicket!.ticket;
    const preview = await this.priceRegistration(registration, manager, pedidoEn);
    const collected = await this.collectedAmount(registration, manager);
    // Falta plata (se pagó menos de lo pedido) o sobra (hay que decidir cómo devolver): lo resuelve el cajero.
    if (collected !== preview.price)
      return { yaCerrada: false as const, cerrada: false, saldoPendiente: Math.max(0, preview.price - collected), registration: withTicket! };
    const saved = await this.cerrarEnTransaccion(manager, id, { closeType: 'NO_CHARGE', expectedPrice: preview.price, expectedCollected: collected }, usuarioId, pedidoEn);
    return { yaCerrada: false as const, cerrada: true, saldoPendiente: 0, registration: saved };
  }

  /**
   * Lo que falta cobrar para dejar pagada una duración planificada, para pedirlo por QR o alias al
   * entrar. Lo calcula el servidor (como el resto de los cobros externos): el mostrador solo elige
   * la duración.
   */
  async montoAnticipo(registrationId: string, minutos: number) {
    const registration = await this.ticketRegistrationRepository.findOne({ where: { id: registrationId }, relations: ['ticket'] });
    if (!registration) throw new NotFoundException('Registro no encontrado.');
    if (registration.departureTime) throw new BadRequestException('El ticket ya está cerrado.');
    const planned = await this.plannedPriceForRegistration(registration, minutos);
    const monto = planned.price - await this.collectedAmount(registration);
    if (monto <= 0) throw new BadRequestException('Lo ya cobrado cubre esta duración: no hay anticipo para cobrar.');
    return { monto, patente: registration.licensePlateOriginal || 'Sin patente' };
  }

  /**
   * Un anticipo pedido por QR o alias que se acreditó: entra como ANTICIPO, guarda la duración
   * planificada y nunca registra la salida (el auto recién entra; si se queda más, al salir se
   * cobra la diferencia). Igual que el anticipo en efectivo, pasa por linkToTodaysBoxList con
   * importe 0 para quedar visible en la caja y la planilla.
   */
  async acreditarAnticipoEn(manager: EntityManager, id: string, monto: number, metodo: MovimientoMetodo, referencia: string, usuarioId: string, anticipo: { minutos: number; etiqueta?: string | null }) {
    const repository = manager.getRepository(TicketRegistration);
    const registration = await repository.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!registration) throw new NotFoundException('Registro no encontrado.');
    if (registration.departureTime) return { yaCerrada: true as const };
    await this.movimientosService.create({ ticketRegistrationId: id, monto, metodo, tipo: 'ANTICIPO', referencia, usuarioId }, manager);
    await this.linkToTodaysBoxList(registration, metodo === 'CASH' ? monto : 0, manager, usuarioId);
    registration.advancePaidAmount = await this.collectedAmount(registration, manager);
    registration.expectedUptoMinutes = anticipo.minutos;
    registration.expectedBracketLabel = anticipo.etiqueta ?? null;
    await repository.save(registration);
    const saved = await repository.findOne({ where: { id }, relations: ['ticket'] });
    return { yaCerrada: false as const, cerrada: false, saldoPendiente: 0, registration: saved! };
  }

  /** El anticipo por QR ya acreditado por MercadoPago (ver acreditarAnticipoEn). */
  async registrarAnticipoExterno(registrationId: string, monto: number, metodo: MovimientoMetodo, referencia: string, usuarioId: string, anticipo: { minutos: number; etiqueta?: string | null }) {
    const r = await this.dataSource.transaction(manager => this.acreditarAnticipoEn(manager, registrationId, monto, metodo, referencia, usuarioId, anticipo));
    if (r.yaCerrada) throw new BadRequestException('El ticket ya está cerrado.');
    this.ticketGateway.emitNewRegistration(r.registration);
    return { cerrada: false, saldoPendiente: 0 };
  }

  /**
   * Cobra el abono en la misma transacción que consume la transferencia y, cobrado al salir, lo
   * retira. Cobrado al registrarlo (`retirar` en false) queda pagado y sigue en la playa.
   */
  async acreditarTransferenciaAbonoEn(manager: EntityManager, id: string, monto: number, _referencia: string, usuarioId: string, retirar = true) {
    await manager.query('SELECT pg_advisory_xact_lock(718904)');
    const repo = manager.getRepository(TicketRegistrationForDay);
    const registration = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!registration) throw new NotFoundException('Abono no encontrado.');
    if (registration.paid || registration.retired) return { yaCerrada: true as const };
    if (registration.price !== monto) throw new ConflictException('El importe del abono cambió. Cancelá y empezá nuevamente.');
    const fecha = dayjs().tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD');
    const box = await this.boxListsService.applyTicketPayment(fecha, 0, manager, undefined, usuarioId);
    registration.boxList = { id: box.id } as BoxList;
    await recordDigital(manager, monto, 'ALIAS', 'Abono ' + id, usuarioId);
    registration.paymentOperatorName = await this.operatorName(usuarioId, manager);
    registration.paid = true;
    registration.paymentMetodo = 'TRANSFER';
    if (retirar) {
      registration.exitTurnoId = (await operatorShift(manager, usuarioId))?.id ?? null;
      registration.retired = true;
      registration.retiredAt = new Date();
      registration.exitOperatorName = await this.operatorName(usuarioId, manager);
    }
    await repo.save(registration);
    return { yaCerrada: false as const, cerrada: retirar, saldoPendiente: 0, registration };
  }

  /**
   * Elimina una estadía que se registró por error (patente equivocada, doble carga). Solo si sigue
   * abierta, sin ningún cobro ni anticipo y sin un QR o una transferencia al alias esperando el
   * pago: con plata de por medio no se borra nada, el libro de movimientos no se toca (se registra
   * la salida y se corrige con un ajuste). Libera la tarjeta física si tenía; el link de su
   * comprobante de entrada deja de abrir (readPublic). Queda en la Actividad (audit-policy) con la
   * patente y la hora de entrada.
   */
  async eliminarEstadiaPorError(id: string) {
    const eliminada = await this.dataSource.transaction(async manager => {
      const repository = manager.getRepository(TicketRegistration);
      const registration = await repository.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!registration) throw new NotFoundException('Registro no encontrado.');
      if (registration.departureTime)
        throw new BadRequestException({ code: 'ESTADIA_CERRADA', message: 'Esta estadía ya tiene la salida registrada: no se puede eliminar.' });
      const cobros = await manager.getRepository(Movimiento).count({ where: { ticketRegistration: { id } } });
      if (cobros > 0 || Number(registration.advancePaidAmount ?? 0) > 0 || Number(registration.legacyCollectedOffset ?? 0) > 0)
        throw new BadRequestException({ code: 'ESTADIA_CON_COBROS', message: 'Esta estadía tiene cobros o anticipos: no se puede eliminar. Registrá la salida y, si hace falta, corregilo con un ajuste.' });
      const [enCurso] = await manager.query(
        `SELECT (SELECT count(*) FROM cobros_mercadopago WHERE "registrationId" = $1 AND estado = 'PENDIENTE')
              + (SELECT count(*) FROM cobros_transferencia WHERE "registrationId" = $1 AND estado IN ('ESPERANDO', 'REVISION')) AS n`,
        [id],
      );
      if (Number(enCurso?.n ?? 0) > 0)
        throw new BadRequestException({ code: 'COBRO_EN_CURSO', message: 'Hay un cobro con QR o al alias esperando el pago: cancelalo antes de eliminar la estadía.' });
      const conTicket = await repository.findOne({ where: { id }, relations: ['ticket'] });
      // Los turnos guardan cuántos vehículos había adentro al empezar («Recibidos») y al
      // terminar («Quedan dentro»). Esta estadía, que nunca salió, quedó contada en cada foto
      // tomada después de su entrada (si ya existía en ese momento): se descuenta, así el turno
      // muestra lo que de verdad había. Salidas, entradas e informes se cuentan en vivo.
      await manager.query(
        `WITH e AS (
           SELECT (("entryDay"::date + COALESCE("entryTime"::time, '00:00'::time)) AT TIME ZONE $2) AS entrada,
                  "createdAt" AS creada, "playaId"
           FROM ticket_registrations WHERE id = $1)
         UPDATE turnos t SET
           "vehiculosInicio" = CASE WHEN t."vehiculosInicio" IS NOT NULL AND t."fechaApertura" > e.entrada AND t."fechaApertura" > e.creada
             THEN GREATEST(t."vehiculosInicio" - 1, 0) ELSE t."vehiculosInicio" END,
           "vehiculosFin" = CASE WHEN t."vehiculosFin" IS NOT NULL AND t."fechaCierre" > e.entrada AND t."fechaCierre" > e.creada
             THEN GREATEST(t."vehiculosFin" - 1, 0) ELSE t."vehiculosFin" END
         FROM e
         WHERE t."playaId" = e."playaId"
           AND ((t."vehiculosInicio" IS NOT NULL AND t."fechaApertura" > e.entrada AND t."fechaApertura" > e.creada)
             OR (t."vehiculosFin" IS NOT NULL AND t."fechaCierre" > e.entrada AND t."fechaCierre" > e.creada))`,
        [id, 'America/Argentina/Buenos_Aires'],
      );
      // El comprobante de entrada no se borra (la playa solo puede crearlos): su link deja de
      // mostrarse porque la lectura pública exige que la estadía exista.
      await repository.delete({ id });
      return {
        id,
        patente: registration.licensePlateOriginal || conTicket?.ticket?.codeBar || registration.lastNameCustomer || null,
        entrada: [registration.entryDay, registration.entryTime?.slice(0, 5)].filter(Boolean).join(' ') || null,
      };
    });
    // Las pantallas la sacan de la lista de vehículos adentro.
    this.ticketGateway.emitNewRegistration({ id, eliminada: true });
    return eliminada;
  }

  /** Avisa a las pantallas que una estadía cambió (lo que hacen los cierres al terminar). */
  emitirRegistro(registration: TicketRegistration) {
    this.ticketGateway.emitNewRegistration(registration);
  }

  // `salidaEn`: solo para un pago externo, la hora en que se pidió el pago; sin él, ahora.
  private async cerrarEnTransaccion(manager: EntityManager, id: string, dto: CloseRegistrationDto, usuarioId: string, salidaEn?: Date) {
      const repository = manager.getRepository(TicketRegistration);
      const registration = await repository.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!registration) throw new NotFoundException('Registro no encontrado.');
      if (registration.departureTime) return registration;
      const withTicket = await repository.findOne({ where: { id }, relations: ['ticket'] });
      registration.ticket = withTicket!.ticket;
      const preview = await this.priceRegistration(registration, manager, salidaEn);
      const collected = await this.collectedAmount(registration, manager);
      if (dto.expectedPrice !== preview.price || dto.expectedCollected !== collected) {
        throw new ConflictException({ code: 'TICKET_PRICE_CHANGED', message: 'El importe cambió. Revisá el resumen actualizado antes de confirmar.' });
      }
      const saldo = Math.max(0, preview.price - collected);
      const refund = Math.max(0, collected - preview.price);
      let cashDelta = 0;
      if (dto.closeType === 'PAYMENT') {
        if (saldo <= 0) throw new BadRequestException('No queda saldo por cobrar.');
        // Un medio por todo el saldo, o el saldo repartido (pago híbrido): un SALDO por medio, así la
        // planilla y el turno ven cada parte con el suyo, y solo el efectivo suma a la caja.
        const pagos = dto.pagos?.length ? dto.pagos : dto.metodo ? [{ metodo: dto.metodo, importe: saldo }] : null;
        if (!pagos) throw new BadRequestException('Elegí el medio de pago.');
        if (new Set(pagos.map(p => p.metodo)).size !== pagos.length) throw new BadRequestException('Cada medio de pago va una sola vez.');
        if (pagos.reduce((s, p) => s + p.importe, 0) !== saldo) throw new BadRequestException(`Los importes tienen que sumar lo que falta cobrar: ${saldo}.`);
        for (const p of pagos) await this.movimientosService.create({ ticketRegistrationId: id, monto: p.importe, metodo: p.metodo, tipo: 'SALDO', referencia: dto.referencia, usuarioId }, manager);
        cashDelta = pagos.filter(p => p.metodo === 'CASH').reduce((s, p) => s + p.importe, 0);
      } else if (dto.closeType === 'NO_CHARGE') {
        if (saldo > 0) throw new BadRequestException('Todavía queda saldo por cobrar.');
      } else if (dto.closeType === 'COURTESY') {
        if (!dto.motivo?.trim()) throw new BadRequestException('El motivo es obligatorio para una cortesía.');
        if (saldo > 0) await this.movimientosService.create({ ticketRegistrationId: id, monto: saldo, metodo: dto.metodo ?? 'CASH', tipo: 'CORTESIA', motivo: dto.motivo, usuarioId }, manager);
      } else throw new BadRequestException('Tipo de cierre inválido.');
      if (refund > 0) {
        if (!dto.refundMetodo) throw new BadRequestException('Confirmá el medio de devolución del excedente.');
        await this.movimientosService.create({ ticketRegistrationId: id, monto: -refund, metodo: dto.refundMetodo, tipo: 'AJUSTE', motivo: 'Devolución de anticipo excedente al cerrar la estadía', usuarioId }, manager);
        if (dto.refundMetodo === 'CASH') cashDelta -= refund;
      }
      const now = dayjs(salidaEn ?? new Date()).tz('America/Argentina/Buenos_Aires');
      registration.entryMode ??= registration.ticket ? 'BARCODE' : 'PLATE';
      registration.vehicleType ??= registration.ticket?.vehicleType as any;
      registration.codeBarTicket = registration.ticket?.codeBar ?? registration.codeBarTicket;
      registration.departureDay = now.format('YYYY-MM-DD');
      registration.departureTime = now.format('HH:mm:ss');
      registration.exitTurnoId = (await operatorShift(manager, usuarioId))?.id ?? null;
      registration.exitOperatorName = await this.operatorName(usuarioId, manager);
      registration.price = preview.price;
      registration.pricingBreakdown = preview.breakdown;
      registration.priceBracketLabel = preview.label;
      registration.priceBracketFallbackUsed = preview.usedFallback;
      registration.appliedPricingDayType = preview.ticketDayType === 'MIXED' ? null : preview.ticketDayType;
      registration.exceededExpectedStay = registration.expectedUptoMinutes != null && preview.elapsedMinutes > registration.expectedUptoMinutes;
      registration.description = `${registration.entryMode === 'BARCODE' ? 'Ticket: ' + registration.codeBarTicket : 'Patente: ' + (registration.licensePlateOriginal ?? 'sin patente')}, Ent: ${registration.entryTime}, Sal: ${registration.departureTime}`;
      await this.linkToTodaysBoxList(registration, cashDelta, manager, usuarioId);
      registration.ticket = null;
      return repository.save(registration);
  }

  async getFrequentCustomers(filters: { from?: string; to?: string; vehicleType?: string; minVisits?: number; search?: string }, pagination?: ListPagination) {
    const minVisits = filters.minVisits ?? 1;

    const durationExpr =
      `EXTRACT(EPOCH FROM ((r."departureDay" + r."departureTime") - (r."entryDay" + r."entryTime")))/60`;

    const qb = this.ticketRegistrationRepository
      .createQueryBuilder('r')
      .select('r.licensePlateNormalized', 'licensePlateNormalized')
      .addSelect('MAX(r.licensePlateOriginal)', 'licensePlateOriginal')
      .addSelect('MAX(r.lastNameCustomer)', 'lastNameCustomer')
      .addSelect(`(ARRAY_AGG(r."phoneCustomer" ORDER BY r."createdAt" DESC, r.id DESC) FILTER (WHERE r."phoneCustomer" IS NOT NULL AND r."phoneCustomer" <> ''))[1]`, 'phoneCustomer')
      .addSelect('MAX(r.vehicleType)', 'vehicleType')
      .addSelect('COUNT(*)', 'visits')
      .addSelect('MIN(r.entryDay)', 'firstVisit')
      .addSelect('MAX(r.entryDay)', 'lastVisit')
      .addSelect('SUM(r.price)', 'totalSpent')
      .addSelect('MODE() WITHIN GROUP (ORDER BY r.priceBracketLabel)', 'mostCommonBracket')
      .addSelect(`PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${durationExpr})`, 'medianDurationMinutes')
      .addSelect(`MIN(${durationExpr})`, 'minDurationMinutes')
      .addSelect(`MAX(${durationExpr})`, 'maxDurationMinutes')
      .where('r.licensePlateNormalized IS NOT NULL')
      .andWhere('r.noPlate = false')
      .groupBy('r.licensePlateNormalized');

    if (filters.from) qb.andWhere('r.entryDay >= :from', { from: filters.from });
    if (filters.to) qb.andWhere('r.entryDay <= :to', { to: filters.to });
    if (filters.vehicleType) qb.andWhere('r.vehicleType = :vehicleType', { vehicleType: filters.vehicleType });

    // El filtro de texto debe aplicarse también a quienes califican por cantidad de visitas.
    qb.having(`(COUNT(*) >= :minVisits OR BOOL_OR(r."phoneCustomer" IS NOT NULL AND r."phoneCustomer" <> ''))`, { minVisits });
    if (filters.search?.trim()) qb.andHaving(`CONCAT_WS(' ', r."licensePlateNormalized", MAX(r."lastNameCustomer"), MAX(r."phoneCustomer")) ILIKE :search`, { search: '%' + filters.search.slice(0, 120).trim().replace(/[\\%_]/g, '\\$&') + '%' });
    let total = 0;
    if (pagination) {
      const [sql, params] = qb.getQueryAndParameters();
      const [count] = await this.dataSource.query(`SELECT COUNT(*) AS total FROM (${sql}) grouped`, params);
      total = Number(count.total);
      qb.offset((pagination.page - 1) * pagination.limit).limit(pagination.limit);
    }
    qb.orderBy('visits', 'DESC').addOrderBy('r.licensePlateNormalized', 'ASC');
    const rows = await qb.getRawMany();
    const data = rows.map((row) => {
      const visits = Number(row.visits);
      const firstVisit = row.firstVisit as string;
      const lastVisit = row.lastVisit as string;
      const avgDaysBetweenVisits =
        visits > 1 ? dayjs(lastVisit).diff(dayjs(firstVisit), 'day') / (visits - 1) : null;

      return {
        licensePlateNormalized: row.licensePlateNormalized as string,
        licensePlateOriginal: row.licensePlateOriginal as string,
        lastNameCustomer: row.lastNameCustomer as string | null,
        phoneCustomer: row.phoneCustomer as string | null,
        vehicleType: row.vehicleType as string,
        visits,
        firstVisit,
        lastVisit,
        avgDaysBetweenVisits,
        medianDurationMinutes: row.medianDurationMinutes != null ? Math.round(Number(row.medianDurationMinutes)) : null,
        minDurationMinutes: row.minDurationMinutes != null ? Math.round(Number(row.minDurationMinutes)) : null,
        maxDurationMinutes: row.maxDurationMinutes != null ? Math.round(Number(row.maxDurationMinutes)) : null,
        mostCommonBracket: row.mostCommonBracket as string | null,
        totalSpent: Number(row.totalSpent),
      };
    });
    return pagination ? listResult(data, total, pagination) : data;
  }

  async getPlateHistory(plateNormalized: string, pagination = { page: 1, limit: 25 }) {
    const [data, total] = await this.ticketRegistrationRepository.findAndCount({
      where: { licensePlateNormalized: plateNormalized },
      order: { entryDay: 'DESC', entryTime: 'DESC', id: 'DESC' },
      skip: (pagination.page - 1) * pagination.limit, take: pagination.limit,
    });
    return listResult(data, total, pagination);
  }
}
