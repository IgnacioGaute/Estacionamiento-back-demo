import { VehicleTypeEntity } from './entities/vehicle-type.entity';
import { CreateVehicleTypeDto, UpdateVehicleTypeDto } from './dto/vehicle-type.dto';
import { assertPricingCoverage, calculateStayPrice, validatePricingOptions } from './pricing/stay-pricing';
import { defaultPricingOptions, PricingOptions } from './pricing/pricing.types';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';
import { Ticket } from './entities/ticket.entity';
import { TicketRegistration } from './entities/ticket-registration.entity';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { BoxListsService } from 'src/box-lists/box-lists.service';
import { BoxList } from 'src/box-lists/entities/box-list.entity';
import { TicketGateway } from './register-gateway';
import { FilterOperator, paginate, Paginated, PaginateQuery } from 'nestjs-paginate';
import { TicketRegistrationForDay } from './entities/ticket-registration-for-day.entity';
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
import { TicketScheduleSettings } from './entities/ticket-schedule-settings.entity';
import { UpdateTicketScheduleDto } from './dto/update-ticket-schedule.dto';
import { TicketDayType } from './entities/ticket.entity';
import { MovimientosService } from 'src/movimientos/movimientos.service';
import { MovimientoMetodo } from 'src/movimientos/entities/movimiento.entity';
import { CreateRegistrationByPlateDto } from './dto/create-registration-by-plate.dto';
import { CloseRegistrationDto } from './dto/close-registration.dto';
import { normalizePlate, toSearchKey } from './utils/license-plate.util';
import { Brackets } from 'typeorm';
import { calculatePrice, resolveDayType, selectBrackets, validateBracket } from './pricing/pricing';
import { PricingSnapshot } from './pricing/pricing.types';
import { CreateTicketRegistrationForDayDto, UpdateTicketStatusDto } from './dto/create-ticket-registration-for-day.dto';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isBetween);

@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

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


  private readonly defaultTicketSchedule = { dayStartHour: 8, dayEndHour: 20, graceMinutes: 5, barcodeTicketsEnabled: true, shiftsEnabled: true, pricingDayTypeBasis: 'EXIT' as const };

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
        if (open.length) throw new BadRequestException('Cerrá el turno abierto antes de desactivar los turnos.');
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

  private async priceRegistration(registration: TicketRegistration, manager?: EntityManager) {
    const vehicle = registration.vehicleType ?? registration.ticket?.vehicleType;
    if (!vehicle) throw new BadRequestException('El registro no tiene tipo de vehículo.');
    const snapshot = registration.pricingSnapshot ?? await this.capturePricing(vehicle, manager, false);
    const entry = dayjs.tz(`${registration.entryDay} ${registration.entryTime}`, 'YYYY-MM-DD HH:mm:ss', 'America/Argentina/Buenos_Aires');
    return { ...calculateStayPrice(snapshot, vehicle, entry.toDate(), new Date()), tariffSnapshotUsed: !!registration.pricingSnapshot };
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

  async createRegistration(ticketId?: string) {
    if (!ticketId) throw new BadRequestException('Falta el identificador del ticket.');
    const result = await this.dataSource.transaction(async manager => {
      const ticket = await manager.getRepository(Ticket).findOne({ where: { id: ticketId }, lock: { mode: 'pessimistic_write' } });
      if (!ticket) throw new NotFoundException('Ticket no encontrado.');
      const repository = manager.getRepository(TicketRegistration);
      const existing = await repository.findOne({ where: { ticket: { id: ticketId }, departureTime: IsNull() }, relations: ['ticket'] });
      // El segundo escaneo prepara el cierre; nunca registra un cobro implícito.
      if (existing) return { registration: existing, requiresClose: true };
      const pricingSnapshot = await this.capturePricing(ticket.vehicleType, manager);
      const now = dayjs(pricingSnapshot.capturedAt).tz('America/Argentina/Buenos_Aires');
      const registration = await repository.save(repository.create({
        description: `Registro de ticket para vehículo tipo ${ticket.vehicleType}`, price: 0,
        entryDay: now.format('YYYY-MM-DD'), entryTime: now.format('HH:mm:ss'),
        ticket, vehicleType: ticket.vehicleType as any, codeBarTicket: ticket.codeBar,
        pricingSnapshot, entryMode: 'BARCODE',
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

async createRegistrationForDay(createTicketRegistrationForDayDto: CreateTicketRegistrationForDayDto) {
  await this.assertVehicleType(createTicketRegistrationForDayDto.vehicleType);
  return this.dataSource.transaction(async manager => {
  try {
    const { ticketTimeType, vehicleType, days, weeks, months } = createTicketRegistrationForDayDto;
    const ticket = manager.getRepository(TicketRegistrationForDay).create(createTicketRegistrationForDayDto);

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
    const boxList = await this.boxListsService.applyTicketPayment(now, cash, manager);

    ticket.boxList = { id: boxList.id } as BoxList;

    const savedTicket = await manager.getRepository(TicketRegistrationForDay).save(ticket);
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
async updateTicketStatus(id: string, dto: Omit<UpdateTicketStatusDto, 'paymentMetodo'> & { paymentMetodo?: 'CASH' | 'TRANSFER' | 'MERCADOPAGO' }) {
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
      ticket.paid = paid;
      ticket.paymentMetodo = method;
      if (dto.retired !== undefined) {
        if (dto.retired && !ticket.retired) ticket.retiredAt = new Date();
        if (!dto.retired) ticket.retiredAt = null;
        ticket.retired = dto.retired;
      }
      return repo.save(ticket);
    });
  }

  // Limpieza masiva del panel "Día/Sem/Mes": solo marca `retired` (los saca de la lista de
  // ocupación), nunca toca `paid` / la caja — eso es una acción separada e independiente.
  async retireRegistrationsForDay(ids: string[]) {
    if (!ids || ids.length === 0) {
      return { affected: 0 };
    }
    const result = await this.ticketRegistrationForDayRepository.update(
      { id: In(ids) },
      { retired: true },
    );
    return { affected: result.affected ?? 0 };
  }

    async findAllRegistrationForDay() {
      try {
        const ticketsDays = await this.ticketRegistrationForDayRepository.find({ relations: ['boxList'] })
        return ticketsDays;
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
    const target = dto.advancePaidAmount ?? collected;
    const delta = target - collected;
    if (delta !== 0) {
      if (!dto.metodo) throw new BadRequestException('Elegí el medio de pago o devolución.');
      if (delta < 0 && !dto.adjustmentReason?.trim()) throw new BadRequestException('Para reducir un anticipo, ingresá el motivo de la devolución.');
      await this.movimientosService.create({ ticketRegistrationId: id, monto: delta, metodo: dto.metodo, tipo: delta > 0 ? 'ANTICIPO' : 'AJUSTE', motivo: dto.adjustmentReason, usuarioId }, manager);
      await this.linkToTodaysBoxList(registration, dto.metodo === 'CASH' ? delta : 0, manager);
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

/**
 * Registra en la estadía un pago que se cobró por fuera del mostrador (hoy, el QR de MercadoPago
 * ya acreditado). Entra como ANTICIPO y no como cierre: la plata llega mientras la estadía sigue
 * abierta, y el cajero cierra después viendo que ya no queda saldo. Así el cobro no depende de
 * que el precio no se haya movido mientras el cliente pagaba.
 *
 * `referencia` guarda el id del pago en MercadoPago: es el rastro que permite reconciliar una
 * fila del libro con un pago real.
 *
 * Pasa por linkToTodaysBoxList aunque no sea efectivo —con importe 0— porque es lo que hace que
 * el pago sea visible en la caja del día y en la planilla; un movimiento suelto no aparece.
 */
async registrarPagoExterno(
  registrationId: string,
  monto: number,
  metodo: MovimientoMetodo,
  referencia: string,
  usuarioId: string,
) {
  const saved = await this.dataSource.transaction(async manager => {
    const repository = manager.getRepository(TicketRegistration);
    const registration = await repository.findOne({ where: { id: registrationId }, lock: { mode: 'pessimistic_write' } });
    if (!registration) throw new NotFoundException('Registro no encontrado.');
    if (registration.departureTime) throw new BadRequestException('El ticket ya está cerrado.');
    await this.movimientosService.create({ ticketRegistrationId: registrationId, monto, metodo, tipo: 'ANTICIPO', referencia, usuarioId }, manager);
    await this.linkToTodaysBoxList(registration, metodo === 'CASH' ? monto : 0, manager);
    registration.advancePaidAmount = await this.collectedAmount(registration, manager);
    await repository.save(registration);
    return repository.findOne({ where: { id: registrationId }, relations: ['ticket'] });
  });
  this.ticketGateway.emitNewRegistration(saved);
  return saved;
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

  async findAllRegistrations() {
    try{
        const registrations = await this.ticketRegistrationRepository.find({
            relations: ['ticket', 'boxList'],
            order: { createdAt: 'DESC' },
          });

        return registrations;
    } catch (error: any) {
        this.logger.error(error.message, error.stack);
    }
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

  async createRegistrationByPlate(dto: CreateRegistrationByPlateDto) {
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
      const argentinaTime = dayjs(pricingSnapshot.capturedAt).tz('America/Argentina/Buenos_Aires');
      const registration = repository.create({
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

      return repository.save(registration);
    });
    this.ticketGateway.emitNewRegistration(saved);
    return saved;
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

    return qb.orderBy('r.entryDay', 'ASC').addOrderBy('r.entryTime', 'ASC').getMany();
  }

  async collectedAmount(registration: TicketRegistration, manager?: EntityManager) {
    const amount = await this.movimientosService.sumByRegistration(registration.id, manager);
    if (registration.pricingSnapshot) return amount;
    registration.legacyCollectedOffset ??= Math.max(0, (registration.advancePaidAmount ?? 0) - amount);
    return amount + registration.legacyCollectedOffset;
  }

  async getCloseSummary(id: string) {
    const registration = await this.ticketRegistrationRepository.findOne({ where: { id }, relations: ['ticket'] });
    if (!registration) throw new NotFoundException('Registro no encontrado.');
    if (registration.departureTime) throw new BadRequestException('Este ticket ya está cerrado.');
    const preview = await this.priceRegistration(registration);
    const totalCollectedSoFar = await this.collectedAmount(registration);
    return { registration, elapsedMinutes: preview.elapsedMinutes, previewBracket: preview,
      totalCollectedSoFar, saldoACobrar: Math.max(0, preview.price - totalCollectedSoFar),
      cambioARetornar: Math.max(0, totalCollectedSoFar - preview.price),
      pricingDayType: preview.ticketDayType, pricingDayTypeBasis: preview.pricingDayTypeBasis, tariffSnapshotUsed: preview.tariffSnapshotUsed };
  }

  private async linkToTodaysBoxList(registration: TicketRegistration, amount: number, manager: EntityManager) {
    const date = dayjs().tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD');
    const box = await this.boxListsService.applyTicketPayment(date, amount, manager);
    registration.dateNow = date;
    registration.boxList = { id: box.id } as BoxList;
  }

  // Ambas identificaciones usan una operación atómica; reintentar un cierre no vuelve a cobrar.
  async closeRegistrationByPlate(id: string, dto: CloseRegistrationDto, usuarioId: string) {
    const saved = await this.dataSource.transaction(async manager => {
      const repository = manager.getRepository(TicketRegistration);
      const registration = await repository.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!registration) throw new NotFoundException('Registro no encontrado.');
      if (registration.departureTime) return registration;
      const withTicket = await repository.findOne({ where: { id }, relations: ['ticket'] });
      registration.ticket = withTicket!.ticket;
      const preview = await this.priceRegistration(registration, manager);
      const collected = await this.collectedAmount(registration, manager);
      if (dto.expectedPrice !== preview.price || dto.expectedCollected !== collected) {
        throw new ConflictException({ code: 'TICKET_PRICE_CHANGED', message: 'El importe cambió. Revisá el resumen actualizado antes de confirmar.' });
      }
      const saldo = Math.max(0, preview.price - collected);
      const refund = Math.max(0, collected - preview.price);
      let cashDelta = 0;
      if (dto.closeType === 'PAYMENT') {
        if (saldo <= 0) throw new BadRequestException('No queda saldo por cobrar.');
        if (!dto.metodo) throw new BadRequestException('Elegí el medio de pago.');
        await this.movimientosService.create({ ticketRegistrationId: id, monto: saldo, metodo: dto.metodo, tipo: 'SALDO', referencia: dto.referencia, usuarioId }, manager);
        cashDelta = dto.metodo === 'CASH' ? saldo : 0;
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
      const now = dayjs().tz('America/Argentina/Buenos_Aires');
      registration.entryMode ??= registration.ticket ? 'BARCODE' : 'PLATE';
      registration.vehicleType ??= registration.ticket?.vehicleType as any;
      registration.codeBarTicket = registration.ticket?.codeBar ?? registration.codeBarTicket;
      registration.departureDay = now.format('YYYY-MM-DD');
      registration.departureTime = now.format('HH:mm:ss');
      registration.price = preview.price;
      registration.pricingBreakdown = preview.breakdown;
      registration.priceBracketLabel = preview.label;
      registration.priceBracketFallbackUsed = preview.usedFallback;
      registration.appliedPricingDayType = preview.ticketDayType === 'MIXED' ? null : preview.ticketDayType;
      registration.exceededExpectedStay = registration.expectedUptoMinutes != null && preview.elapsedMinutes > registration.expectedUptoMinutes;
      registration.description = `${registration.entryMode === 'BARCODE' ? 'Ticket: ' + registration.codeBarTicket : 'Patente: ' + (registration.licensePlateOriginal ?? 'sin patente')}, Ent: ${registration.entryTime}, Sal: ${registration.departureTime}`;
      await this.linkToTodaysBoxList(registration, cashDelta, manager);
      registration.ticket = null;
      return repository.save(registration);
    });
    this.ticketGateway.emitNewRegistration(saved);
    return saved;
  }

  async getFrequentCustomers(filters: { from?: string; to?: string; vehicleType?: string; minVisits?: number }) {
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

    qb.having(`COUNT(*) >= :minVisits OR BOOL_OR(r."phoneCustomer" IS NOT NULL AND r."phoneCustomer" <> '')`, { minVisits });
    qb.orderBy('visits', 'DESC');

    const rows = await qb.getRawMany();

    return rows.map((row) => {
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
  }

  async getPlateHistory(plateNormalized: string) {
    return this.ticketRegistrationRepository.find({
      where: { licensePlateNormalized: plateNormalized },
      order: { entryDay: 'DESC', entryTime: 'DESC' },
    });
  }
}
