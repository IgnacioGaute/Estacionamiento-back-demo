import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Ticket } from './entities/ticket.entity';
import { TicketRegistration } from './entities/ticket-registration.entity';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { ScannerService } from '../scanner/scanner.service';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { format } from 'date-fns';
import { BoxListsService } from 'src/box-lists/box-lists.service';
import { CreateTicketRegistrationDto } from './dto/create-ticket-registration.dto';
import { BoxList } from 'src/box-lists/entities/box-list.entity';
import { TicketGateway } from './register-gateway';
import { UpdateTicketRegistrationDto } from './dto/update-ticket-registration.dto';
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
import { CreateRegistrationByPlateDto } from './dto/create-registration-by-plate.dto';
import { CloseRegistrationDto } from './dto/close-registration.dto';
import { normalizePlate, toSearchKey } from './utils/license-plate.util';
import { Brackets } from 'typeorm';

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
  ) {}

  async createTicketPrice(createTicketPriceDto: CreateTicketPriceDto) {
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


  private readonly defaultTicketSchedule = { dayStartHour: 8, dayEndHour: 20, graceMinutes: 5, barcodeTicketsEnabled: true };

  async getSchedule(): Promise<{ dayStartHour: number; dayEndHour: number; graceMinutes: number; barcodeTicketsEnabled: boolean }> {
    try {
      const [latest] = await this.ticketScheduleSettingsRepository.find({
        order: { updatedAt: 'DESC' },
        take: 1,
      });
      return latest ?? this.defaultTicketSchedule;
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
      throw error;
    }
  }

  async updateSchedule(updateTicketScheduleDto: UpdateTicketScheduleDto) {
    try {
      await this.ticketScheduleSettingsRepository.clear();
      const schedule = this.ticketScheduleSettingsRepository.create(updateTicketScheduleDto);
      return await this.ticketScheduleSettingsRepository.save(schedule);
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
      throw error;
    }
  }

  private resolveTicketDayType(
    schedule: { dayStartHour: number; dayEndHour: number },
    hour: number,
  ): TicketDayType {
    const { dayStartHour, dayEndHour } = schedule;
    const isDay =
      dayStartHour < dayEndHour
        ? hour >= dayStartHour && hour < dayEndHour
        : hour >= dayStartHour || hour < dayEndHour;
    return isDay ? 'DAY' : 'NIGHT';
  }

  private async resolveCurrentTicketDayType(): Promise<TicketDayType> {
    const schedule = await this.getSchedule();
    const currentHour = dayjs().tz('America/Argentina/Buenos_Aires').hour();
    return this.resolveTicketDayType(schedule, currentHour);
  }

  async create(createTicketDto: CreateTicketDto) {
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
    try {

        const ticket = await this.ticketRepository.findOne({ where: { id: ticketId } });

        if (!ticket) {
            this.logger.warn(`No se encontró un ticket con ID: ${ticketId}`);
            return null;
        }

        await this.ensureBracketsConfigured(ticket.vehicleType);

        const existingRegistration = await this.ticketRegistrationRepository.findOne({
            where: { ticket: { id: ticketId } },
            relations: ['ticket'],
        });


        if (!existingRegistration) {
            const argentinaTime = (dayjs().tz('America/Argentina/Buenos_Aires') as dayjs.Dayjs);
  
            const createTicketRegistrationDto: CreateTicketRegistrationDto = {
                description: `Registro de ticket para vehículo tipo ${ticket.vehicleType}`,
                price: 0,
                entryDay: argentinaTime.format('YYYY-MM-DD'),
                entryTime: argentinaTime.format('HH:mm:ss'),
                departureDay: null,
                departureTime: null,
                dateNow: null
            };

            const newRegistration = this.ticketRegistrationRepository.create({
                ...createTicketRegistrationDto,
                ticket,
            });

            const savedTicket = await this.ticketRegistrationRepository.save(newRegistration);
            this.ticketGateway.emitNewRegistration(savedTicket);
            return savedTicket;
        } else {
          const argentinaTime = dayjs().tz('America/Argentina/Buenos_Aires').startOf('day');
          const now = argentinaTime.format('YYYY-MM-DD')
            return await this.updateRegistration(existingRegistration, now, ticket);
        }
    } catch (error: any) {
        if (!(error instanceof NotFoundException) && !(error instanceof BadRequestException)) {
          this.logger.error(error.message, error.stack);
        }
        throw error;
    }
}

    async findAllRegistrationForDay() {
      try {
        const ticketsDays = await this.ticketRegistrationForDayRepository.find()
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
    try{
      const ticket = await this.ticketRegistrationForDayRepository.findOne({where:{id:id}})
      let boxList = await this.boxListsService.findBoxByDate(ticket.dateNow);
  
      if (!boxList) {
        throw new NotFoundException('Box list not found');
      }
      if(ticket.paid === true){
        boxList.totalPrice -= ticket.price;
        await this.boxListsService.updateBox(boxList.id, {
          totalPrice: boxList.totalPrice,
        });
      }



      if(!ticket){
        throw new NotFoundException('Ticket list not found')
      }

      await this.ticketRegistrationForDayRepository.remove(ticket);

      return {message: 'Ticket list removed successfully'}
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }




// Corta el escaneo (entrada o salida) si todavía no hay ninguna franja de precio cargada
// para ese tipo de vehículo — sin tarifas no hay forma de cobrar la estadía después.
private async ensureBracketsConfigured(vehicleType: string): Promise<void> {
  const count = await this.ticketPriceBracketRepository.count({ where: { vehicleType: vehicleType as any } });
  if (count === 0) {
    throw new NotFoundException({
      code: 'TICKET_PRICE_BRACKET_NOT_FOUND',
      message: `No hay tarifas configuradas para el tipo de vehículo ${vehicleType}. Pedile al admin que cargue al menos una franja de precio en Tarifas antes de escanear.`,
    });
  }
}

// Resuelve el precio final de una estadía según el tiempo transcurrido, buscando en la
// escalera de franjas configuradas (TicketPriceBracket) la primera que todavía cubre ese
// tiempo (con la tolerancia de graceMinutes antes de saltar a la franja siguiente). Si el
// tiempo transcurrido supera todas las franjas configuradas, se cobra la más alta (nunca se
// bloquea la salida) y se marca usedFallback para advertir al operador y quedar en el log.
private async resolveExitPrice(
  vehicleType: string,
  ticketDayType: TicketDayType,
  elapsedMinutes: number,
): Promise<{ price: number; label: string; usedFallback: boolean }> {
  const brackets = await this.ticketPriceBracketRepository.find({
    where: [
      { vehicleType: vehicleType as any, ticketDayType: ticketDayType as any },
      { vehicleType: vehicleType as any, ticketDayType: IsNull() },
    ],
  });

  if (brackets.length === 0) {
    throw new NotFoundException({
      code: 'TICKET_PRICE_BRACKET_NOT_FOUND',
      message: `No hay tarifas configuradas para el tipo de vehículo ${vehicleType}. Pedile al admin que cargue al menos una franja de precio en Tarifas antes de registrar salidas.`,
    });
  }

  const sorted = [...brackets].sort((a, b) => {
    if (a.uptoMinutes === null) return 1;
    if (b.uptoMinutes === null) return -1;
    return a.uptoMinutes - b.uptoMinutes;
  });

  const schedule = await this.getSchedule();
  const graceMinutes = schedule.graceMinutes ?? 5;
  const lastBracket = sorted[sorted.length - 1];

  let previous: TicketPriceBracket | null = null;
  for (const bracket of sorted) {
    if (bracket.uptoMinutes === null) {
      return { ...this.priceBracketAmount(bracket, elapsedMinutes, previous), usedFallback: false };
    }
    // La tolerancia solo tiene sentido como gracia antes de saltar a la franja SIGUIENTE.
    // La última franja con techo no tiene una franja siguiente a la que "no saltar todavía",
    // así que ahí no se aplica: pasarse de su "hasta", aunque sea por poco, ya cuenta como
    // estadía sin cobertura y dispara el aviso (antes la tolerancia lo tapaba en silencio).
    const isLastWithCeiling = bracket === lastBracket;
    const threshold = isLastWithCeiling ? bracket.uptoMinutes : bracket.uptoMinutes + graceMinutes;
    if (elapsedMinutes <= threshold) {
      return { price: bracket.price, label: bracket.label, usedFallback: false };
    }
    previous = bracket;
  }

  this.logger.warn(
    `Estadía de ${elapsedMinutes} min (${vehicleType}/${ticketDayType}) superó todas las franjas configuradas; se cobró la última ("${lastBracket.label}"). Conviene dejar la última franja de Tarifas sin "hasta".`,
  );
  return { ...this.priceBracketAmount(lastBracket, elapsedMinutes, previous), usedFallback: true };
}

// Si la franja es de tarifa recurrente (sin límite + recurringUnitMinutes seteado), el precio
// es ACUMULATIVO: se cobra el precio de la última franja con techo (si hay una antes) más
// `price` por cada bloque de recurringUnitMinutes que pasó DESDE ese punto en adelante — no
// se recalcula el tiempo total desde cero. Si no hay franja anterior, cuenta desde el minuto 0.
// Sin recurringUnitMinutes, es un monto fijo único como cualquier franja.
private priceBracketAmount(
  bracket: TicketPriceBracket,
  elapsedMinutes: number,
  previous: TicketPriceBracket | null,
): { price: number; label: string } {
  if (bracket.uptoMinutes !== null || !bracket.recurringUnitMinutes) {
    return { price: bracket.price, label: bracket.label };
  }
  const baseMinutes = previous?.uptoMinutes ?? 0;
  const basePrice = previous?.price ?? 0;
  const overageMinutes = Math.max(0, elapsedMinutes - baseMinutes);
  const units = Math.max(1, Math.ceil(overageMinutes / bracket.recurringUnitMinutes));
  const total = basePrice + bracket.price * units;
  const label = previous
    ? `${bracket.label} ($${basePrice} + ${units} × $${bracket.price})`
    : `${bracket.label} (${units} × $${bracket.price})`;
  return { price: total, label };
}

async updateRegistration(existingRegistration: TicketRegistration, formattedDay: string, ticket: Ticket) {
    try {

      const entryAt = dayjs.tz(
        `${existingRegistration.entryDay} ${existingRegistration.entryTime}`,
        'YYYY-MM-DD HH:mm:ss',
        'America/Argentina/Buenos_Aires',
      );

      if (!entryAt.isValid()) {
        throw new BadRequestException('Invalid entryDay/entryTime');
      }

      const argentinaTime = dayjs().tz('America/Argentina/Buenos_Aires');
      // Minutos desde la entrada (usa entryDay + entryTime juntos, no solo la hora, para que
      // una estadía que cruza la medianoche o dura varios días se calcule bien).
      const minutesPassed = argentinaTime.diff(entryAt, 'minute');

      const ticketDayType = await this.resolveCurrentTicketDayType();
      const { price: finalPrice, label: bracketLabel, usedFallback } = await this.resolveExitPrice(
        ticket.vehicleType,
        ticketDayType,
        minutesPassed,
      );
      const amountDue = Math.max(0, finalPrice - (existingRegistration.advancePaidAmount ?? 0));

      // Si el operador había avisado una duración esperada (ej. "3 días" al cobrar por
      // adelantado), marcamos si la estadía real se pasó de ese tope.
      const exceededExpectedStay =
        existingRegistration.expectedUptoMinutes != null && minutesPassed > existingRegistration.expectedUptoMinutes;

      ticket.price = finalPrice;

        const updateTicketRegistrationDto: UpdateTicketRegistrationDto = {
            description: `Tipo: ${existingRegistration.ticket.vehicleType}, Ent: ${existingRegistration.entryTime}, Sal: ${argentinaTime.format('HH:mm:ss')}`,
            price: finalPrice ,
            codeBarTicket: ticket.codeBar,
            entryDay: existingRegistration.entryDay,
            entryTime: existingRegistration.entryTime,
            departureDay: argentinaTime.format('YYYY-MM-DD'),
            departureTime: argentinaTime.format('HH:mm:ss'),
            dateNow: formattedDay,
            priceBracketLabel: bracketLabel,
            priceBracketFallbackUsed: usedFallback,
            exceededExpectedStay,
        };

        const updatedRegistration = this.ticketRegistrationRepository.create({
            ...existingRegistration,
            ...updateTicketRegistrationDto,
            ticket,
        });

        const savedTicket = await this.ticketRegistrationRepository.save(updatedRegistration);

        const boxListDate = formattedDay;
        let boxList = await this.boxListsService.findBoxByDate(boxListDate);

        if (!boxList) {
            boxList = await this.boxListsService.createBox({
                date: boxListDate,
                totalPrice: amountDue
            });
        } else {
            boxList.totalPrice += amountDue;

            await this.boxListsService.updateBox(boxList.id, {
                totalPrice: boxList.totalPrice,
            });
        }

        savedTicket.boxList = { id: boxList.id } as BoxList;
        savedTicket.ticket = null;
        await this.ticketRegistrationRepository.save(savedTicket);
        this.ticketGateway.emitNewRegistration(savedTicket);

        return savedTicket;
    } catch (error: any) {
        if (!(error instanceof NotFoundException) && !(error instanceof BadRequestException)) {
          this.logger.error(error.message, error.stack);
        }
        throw error;
    }
}

async addAdvancePayment(id: string, dto: AdvancePaymentTicketRegistrationDto, usuarioId: string) {
  try {
    const registration = await this.ticketRegistrationRepository.findOne({
      where: { id },
      relations: ['ticket'],
    });

    if (!registration) {
      throw new NotFoundException('Registro no encontrado');
    }

    // Antes esto exigía `registration.ticket` (solo tickets por código de barras) — un
    // registro por patente nunca lo tiene, así que quedaba afuera sin razón real: lo único
    // que importa acá es que la entrada siga activa.
    if (registration.departureTime) {
      throw new BadRequestException('Solo se puede cobrar por adelantado una entrada activa, sin salida registrada.');
    }

    const previousAdvance = registration.advancePaidAmount ?? 0;
    const newAdvance = dto.advancePaidAmount ?? previousAdvance;
    const delta = newAdvance - previousAdvance;

    registration.advancePaidAmount = newAdvance;
    if (dto.firstNameCustomer !== undefined) registration.firstNameCustomer = dto.firstNameCustomer;
    if (dto.lastNameCustomer !== undefined) registration.lastNameCustomer = dto.lastNameCustomer;
    if (dto.vehiclePlateCustomer !== undefined) registration.vehiclePlateCustomer = dto.vehiclePlateCustomer;
    if (dto.expectedBracketLabel !== undefined) registration.expectedBracketLabel = dto.expectedBracketLabel;
    if (dto.expectedUptoMinutes !== undefined) registration.expectedUptoMinutes = dto.expectedUptoMinutes;

    // El anticipo cobrado ahora es plata real entrando a caja — tiene que pasar por
    // MovimientosService.create() como todo lo demás (ver el comentario en esa clase), no
    // sumarse a mano al total de la caja. Eso hacía la versión anterior de este método: el
    // anticipo nunca quedaba registrado como movimiento del ticket, así que al cerrar (que sí
    // suma sus movimientos) el sistema volvía a pedir el precio completo — cobro duplicado.
    // Si el monto bajó (corrección), no se genera movimiento — reducir un anticipo ya cobrado
    // necesita un AJUSTE con motivo, que este formulario todavía no pide.
    if (delta > 0) {
      await this.movimientosService.create({
        ticketRegistrationId: id,
        monto: delta,
        metodo: dto.metodo ?? 'CASH',
        tipo: 'ANTICIPO',
        usuarioId,
      });
      await this.linkToTodaysBoxList(registration, delta);
    }

    const savedRegistration = await this.ticketRegistrationRepository.save(registration);
    this.ticketGateway.emitNewRegistration(savedRegistration);
    return savedRegistration;
  } catch (error: any) {
    if (!(error instanceof NotFoundException) && !(error instanceof BadRequestException)) {
      this.logger.error(error.message, error.stack);
    }
    throw error;
  }
}

async createPriceBracket(createTicketPriceBracketDto: CreateTicketPriceBracketDto) {
  try {
    const bracket = this.ticketPriceBracketRepository.create(createTicketPriceBracketDto);
    return await this.ticketPriceBracketRepository.save(bracket);
  } catch (error: any) {
    this.logger.error(error.message, error.stack);
    throw error;
  }
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

async updatePriceBracket(id: string, updateTicketPriceBracketDto: UpdateTicketPriceBracketDto) {
  try {
    const bracket = await this.ticketPriceBracketRepository.findOne({ where: { id } });
    if (!bracket) {
      throw new NotFoundException('Franja de precio no encontrada');
    }
    const updated = this.ticketPriceBracketRepository.merge(bracket, updateTicketPriceBracketDto);
    return await this.ticketPriceBracketRepository.save(updated);
  } catch (error: any) {
    if (!(error instanceof NotFoundException)) {
      this.logger.error(error.message, error.stack);
    }
    throw error;
  }
}

async removePriceBracket(id: string) {
  try {
    const bracket = await this.ticketPriceBracketRepository.findOne({ where: { id } });
    if (!bracket) {
      throw new NotFoundException('Franja de precio no encontrada');
    }
    await this.ticketPriceBracketRepository.remove(bracket);
    return { message: 'Franja de precio eliminada correctamente' };
  } catch (error: any) {
    if (!(error instanceof NotFoundException)) {
      this.logger.error(error.message, error.stack);
    }
    throw error;
  }
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
    try {
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

        const existing = await this.ticketRegistrationRepository.findOne({
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

      const argentinaTime = dayjs().tz('America/Argentina/Buenos_Aires');

      const registration = this.ticketRegistrationRepository.create({
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
        noPlate: !!dto.noPlate,
        duplicatePlateOverrideReason: dto.duplicateOverride ? dto.duplicateOverrideReason ?? null : null,
        duplicateOfRegistrationId,
      });

      const saved = await this.ticketRegistrationRepository.save(registration);
      this.ticketGateway.emitNewRegistration(saved);
      return saved;
    } catch (error: any) {
      if (!(error instanceof BadRequestException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
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
            .orWhere('r.lastNameCustomer ILIKE :raw', { raw: `%${raw}%` });
        }),
      );
    }

    return qb.orderBy('r.entryDay', 'ASC').addOrderBy('r.entryTime', 'ASC').getMany();
  }

  async getCloseSummary(id: string) {
    const registration = await this.ticketRegistrationRepository.findOne({ where: { id } });
    if (!registration) {
      throw new NotFoundException('Registro no encontrado');
    }
    if (registration.ticket) {
      throw new BadRequestException('Este ticket se cierra escaneando el código de barras, no desde acá.');
    }
    if (registration.departureTime) {
      throw new BadRequestException('Este ticket ya está cerrado.');
    }

    const elapsedMinutes = this.minutesSinceEntry(registration.entryDay!, registration.entryTime!);
    const ticketDayType = await this.resolveCurrentTicketDayType();
    const preview = await this.resolveExitPrice(registration.vehicleType!, ticketDayType, elapsedMinutes);

    const totalCollectedSoFar = await this.movimientosService.sumByRegistration(id);
    const saldoACobrar = Math.max(0, preview.price - totalCollectedSoFar);
    const cambioARetornar = Math.max(0, totalCollectedSoFar - preview.price);

    return {
      registration,
      elapsedMinutes,
      previewBracket: preview,
      totalCollectedSoFar,
      saldoACobrar,
      cambioARetornar,
    };
  }

  // Vincula el registro a la caja del día de hoy (Argentina) y, si corresponde, suma el monto
  // efectivamente cobrado ahora al total de esa caja. Antes esto solo pasaba en el cierre por
  // código de barras (updateRegistration) — el flujo por patente (hoy el principal) nunca
  // vinculaba nada, así que sus cobros (anticipos y saldo final) no aparecían en ninguna caja
  // ni en la planilla, aunque el movimiento sí quedaba registrado en la tabla de movimientos.
  private async linkToTodaysBoxList(registration: TicketRegistration, amountCollectedNow: number) {
    const boxListDate = dayjs().tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD');

    let boxList = await this.boxListsService.findBoxByDate(boxListDate);
    if (!boxList) {
      boxList = await this.boxListsService.createBox({ date: boxListDate, totalPrice: amountCollectedNow });
    } else if (amountCollectedNow > 0) {
      boxList.totalPrice += amountCollectedNow;
      await this.boxListsService.updateBox(boxList.id, { totalPrice: boxList.totalPrice });
    }

    registration.dateNow = boxListDate;
    registration.boxList = { id: boxList.id } as BoxList;
  }

  async closeRegistrationByPlate(id: string, dto: CloseRegistrationDto, usuarioId: string) {
    try {
      const registration = await this.ticketRegistrationRepository.findOne({ where: { id } });
      if (!registration) {
        throw new NotFoundException('Registro no encontrado');
      }
      if (registration.ticket) {
        throw new BadRequestException('Este ticket se cierra escaneando el código de barras, no desde acá.');
      }
      if (registration.departureTime) {
        throw new BadRequestException('Este ticket ya está cerrado.');
      }

      const elapsedMinutes = this.minutesSinceEntry(registration.entryDay!, registration.entryTime!);
      const ticketDayType = await this.resolveCurrentTicketDayType();
      const { price: finalPrice, label: bracketLabel, usedFallback } = await this.resolveExitPrice(
        registration.vehicleType!,
        ticketDayType,
        elapsedMinutes,
      );

      const totalCollectedSoFar = await this.movimientosService.sumByRegistration(id);
      const saldo = Math.max(0, finalPrice - totalCollectedSoFar);

      const exceededExpectedStay =
        registration.expectedUptoMinutes != null && elapsedMinutes > registration.expectedUptoMinutes;

      if (dto.closeType === 'PAYMENT') {
        if (saldo <= 0) {
          throw new BadRequestException('No queda saldo por cobrar — usá "cerrar sin cobro".');
        }
        if (!dto.metodo) {
          throw new BadRequestException('Elegí el medio de pago.');
        }
        await this.movimientosService.create({
          ticketRegistrationId: id,
          monto: saldo,
          metodo: dto.metodo,
          tipo: 'SALDO',
          referencia: dto.referencia,
          usuarioId,
        });
      } else if (dto.closeType === 'NO_CHARGE') {
        if (saldo > 0) {
          throw new BadRequestException('Todavía queda saldo por cobrar.');
        }
      } else if (dto.closeType === 'COURTESY') {
        if (!dto.motivo?.trim()) {
          throw new BadRequestException('El motivo es obligatorio para una cortesía.');
        }
        if (saldo > 0) {
          await this.movimientosService.create({
            ticketRegistrationId: id,
            monto: saldo,
            metodo: dto.metodo ?? 'CASH',
            tipo: 'CORTESIA',
            motivo: dto.motivo,
            usuarioId,
          });
        }
      }

      const argentinaTime = dayjs().tz('America/Argentina/Buenos_Aires');
      registration.departureDay = argentinaTime.format('YYYY-MM-DD');
      registration.departureTime = argentinaTime.format('HH:mm:ss');
      registration.price = finalPrice;
      registration.priceBracketLabel = bracketLabel;
      registration.priceBracketFallbackUsed = usedFallback;
      registration.exceededExpectedStay = exceededExpectedStay;
      registration.description = `Patente: ${registration.licensePlateOriginal ?? 'sin patente'}, Ent: ${registration.entryTime}, Sal: ${argentinaTime.format('HH:mm:ss')}`;

      const amountCollectedNow = dto.closeType === 'PAYMENT' ? saldo : 0;
      await this.linkToTodaysBoxList(registration, amountCollectedNow);

      const saved = await this.ticketRegistrationRepository.save(registration);
      this.ticketGateway.emitNewRegistration(saved);
      return saved;
    } catch (error: any) {
      if (!(error instanceof BadRequestException) && !(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────────────────
  // Historial de clientes frecuentes — se arma con una consulta sobre los tickets por patente
  // ya cerrados, agrupados por patente. Sin tabla nueva: si el volumen crece y esto se pone
  // lento, ahí conviene una tabla resumen actualizada al cerrar cada ticket, no antes.
  // Quedan afuera los "sin patente" (no hay con qué agrupar).
  // ────────────────────────────────────────────────────────────────────────────────────────

  async getFrequentCustomers(filters: { from?: string; to?: string; vehicleType?: string; minVisits?: number }) {
    const minVisits = filters.minVisits ?? 1;

    const durationExpr =
      `EXTRACT(EPOCH FROM ((r."departureDay" + r."departureTime") - (r."entryDay" + r."entryTime")))/60`;

    const qb = this.ticketRegistrationRepository
      .createQueryBuilder('r')
      .select('r.licensePlateNormalized', 'licensePlateNormalized')
      .addSelect('MAX(r.licensePlateOriginal)', 'licensePlateOriginal')
      .addSelect('MAX(r.lastNameCustomer)', 'lastNameCustomer')
      .addSelect('MAX(r.vehicleType)', 'vehicleType')
      .addSelect('COUNT(*)', 'visits')
      .addSelect('MIN(r.entryDay)', 'firstVisit')
      .addSelect('MAX(r.entryDay)', 'lastVisit')
      .addSelect('SUM(r.price)', 'totalSpent')
      .addSelect('MODE() WITHIN GROUP (ORDER BY r.priceBracketLabel)', 'mostCommonBracket')
      .addSelect(`PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${durationExpr})`, 'medianDurationMinutes')
      .addSelect(`MIN(${durationExpr})`, 'minDurationMinutes')
      .addSelect(`MAX(${durationExpr})`, 'maxDurationMinutes')
      .where('r.departureTime IS NOT NULL')
      .andWhere('r.licensePlateNormalized IS NOT NULL')
      .andWhere('r.noPlate = false')
      .groupBy('r.licensePlateNormalized');

    if (filters.from) qb.andWhere('r.entryDay >= :from', { from: filters.from });
    if (filters.to) qb.andWhere('r.entryDay <= :to', { to: filters.to });
    if (filters.vehicleType) qb.andWhere('r.vehicleType = :vehicleType', { vehicleType: filters.vehicleType });

    qb.having('COUNT(*) >= :minVisits', { minVisits });
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
