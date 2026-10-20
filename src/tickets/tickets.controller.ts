import { CreateVehicleTypeDto, UpdateVehicleTypeDto } from './dto/vehicle-type.dto';
import { Controller, Get, Post, Body, Patch, Param, Query, Delete, UseGuards, Req, UnauthorizedException, ParseIntPipe } from '@nestjs/common';
import { AuthenticatedRequest } from 'src/types/request';
import { CreateRegistrationByPlateDto } from './dto/create-registration-by-plate.dto';
import { DiscountRegistrationDto } from './dto/discount-registration.dto';
import { PagoParcialDto } from './dto/pago-parcial.dto';
import { CorregirEntradaDto } from './dto/corregir-entrada.dto';
import { CorregirDatosEstadiaDto } from './dto/corregir-datos-estadia.dto';
import { CloseRegistrationDto } from './dto/close-registration.dto';
import { SalidaAnteriorDto } from './dto/salida-anterior.dto';
import { PreviewPriceDto, SimulatePriceDto } from './dto/preview-price.dto';
import { TicketsService } from './tickets.service';
import { TariffPlanService } from './tariff-plan.service';
import { SimulateTariffPlanDto, UpdateTariffPlanDto } from './dto/tariff-plan.dto';
import { listPagination } from 'src/utils/list-pagination';
import { OfflineService } from './offline.service';
import { OfflineDeviceDto, OfflineOperationDto, OfflineFinishDto } from './dto/offline.dto';
import { ParkingReceiptsService } from './parking-receipts.service';
import { IssueParkingReceiptDto } from './dto/receipt-delivery.dto';
import { ParseUUIDPipe } from '@nestjs/common';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { Paginate, Paginated, PaginateQuery } from 'nestjs-paginate';
import { Ticket } from './entities/ticket.entity';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { AuthOrTokenAuthGuard } from 'src/utils/guards/auth-or-token.guard';
import { TicketPrice } from './entities/ticket-price.entity';
import { CreateTicketPriceDto } from './dto/create-ticket-price.dto';
import { UpdateTicketPriceDto } from './dto/update-ticket-price.dto';
import { TicketPriceBracket } from './entities/ticket-price-bracket.entity';
import { CreateTicketPriceBracketDto } from './dto/create-ticket-price-bracket.dto';
import { UpdateTicketPriceBracketDto } from './dto/update-ticket-price-bracket.dto';
import { AdvancePaymentTicketRegistrationDto } from './dto/advance-payment-ticket-registration.dto';
import { UpdateTicketScheduleDto } from './dto/update-ticket-schedule.dto';
import { CreateTicketRegistrationForDayDto, UpdateTicketStatusDto } from './dto/create-ticket-registration-for-day.dto';

@Controller('tickets')
@UseGuards(AuthOrTokenAuthGuard)
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService, private readonly parkingReceipts: ParkingReceiptsService, private readonly offline: OfflineService, private readonly tariffPlans: TariffPlanService) {}

  @Get('tariff-plan')
  getTariffPlan() { return this.tariffPlans.getPlan(); }

  @Patch('tariff-plan')
  updateTariffPlan(@Body() dto: UpdateTariffPlanDto) { return this.tariffPlans.updatePlan(dto); }

  @Post('tariff-plan/simulate')
  simulateTariffPlan(@Body() dto: SimulateTariffPlanDto) { return this.tariffPlans.simulate(dto); }

  @Post('offline/prepare')
  prepareOffline(@Body() dto: OfflineDeviceDto) { return this.offline.prepare(dto.deviceId, dto.refresh); }
  @Post('offline/sync')
  syncOffline(@Body() dto: OfflineOperationDto) { return this.offline.synchronize(dto); }
  @Post('offline/finish')
  finishOffline(@Body() dto: OfflineFinishDto) { return this.offline.finish(dto); }

  @Post('registrations/:id/receipt')
  issueParkingReceipt(@Param('id', ParseUUIDPipe) id: string, @Body() dto: IssueParkingReceiptDto) {
    return this.parkingReceipts.issue(id, dto.kind);
  }

  @Post()
  create(@Body() createTicketDto: CreateTicketDto) {
    return this.ticketsService.create(createTicketDto);
  }

  @Get('vehicle-types')
  getVehicleTypes() { return this.ticketsService.getVehicleTypes(); }

  @Post('vehicle-types')
  createVehicleType(@Body() dto: CreateVehicleTypeDto) { return this.ticketsService.createVehicleType(dto); }

  @Patch('vehicle-types/:code')
  updateVehicleType(@Param('code') code: string, @Body() dto: UpdateVehicleTypeDto) { return this.ticketsService.updateVehicleType(code, dto); }

  @Get('schedule-settings')
  getSchedule() {
    return this.ticketsService.getSchedule();
  }

  @Patch('schedule-settings')
  updateSchedule(@Body() updateTicketScheduleDto: UpdateTicketScheduleDto) {
    return this.ticketsService.updateSchedule(updateTicketScheduleDto);
  }

  @Get()
  findAll(@Paginate() query: PaginateQuery): Promise<Paginated<Ticket>> {
    return this.ticketsService.findAll(query);
  }
  @Get('registrationForDays')
  findAllRegistrationForDay(@Query('page') page?: string, @Query('limit') limit?: string, @Query('operation') operation?: string) {
    return this.ticketsService.findAllRegistrationForDay(listPagination(page, limit), operation === 'true');
  }

  @Get('registrationForDays/summary')
  getTicketRegistrationForDaysSummary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.ticketsService.getTicketRegistrationForDaysSummary(from, to);
  }

  @Post('registrationForDays')
  createRegistrationForDay(
    @Req() req: AuthenticatedRequest,
    @Body() createTicketRegistrationForDayDto: CreateTicketRegistrationForDayDto,
  ) {
    if (!req.user?.userId) {
      throw new UnauthorizedException('Esta acción requiere un usuario autenticado.');
    }
    return this.ticketsService.createRegistrationForDay(createTicketRegistrationForDayDto, req.user.userId);
  }

  // Va antes de `registrationForDays/:id/status` para que "retire-many" no entre como un id.
  @Patch('registrationForDays/retire-many')
  retireRegistrationsForDay(@Req() req: AuthenticatedRequest, @Body('ids') ids: string[]) {
    if (!req.user?.userId) throw new UnauthorizedException('Esta acción requiere un usuario autenticado.');
    return this.ticketsService.retireRegistrationsForDay(ids, req.user.userId);
  }

  @Patch('registrationForDays/:id/status')
  updateTicketStatus(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateTicketStatusDto,
  ) {
    if (!req.user?.userId) {
      throw new UnauthorizedException('Esta acción requiere un usuario autenticado.');
    }
    return this.ticketsService.updateTicketStatus(id, dto, req.user.userId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateTicketDto: UpdateTicketDto) {
    return this.ticketsService.update(id, updateTicketDto);
  }
  @Patch('registrations/:id/advance-payment')
  addAdvancePayment(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: AdvancePaymentTicketRegistrationDto,
  ) {
    if (!req.user?.userId) {
      throw new UnauthorizedException('Esta acción requiere un usuario autenticado.');
    }
    return this.ticketsService.addAdvancePayment(id, dto, req.user.userId);
  }

  @Get('registrations/:id/planned-price')
  previewPlannedPrice(@Param('id', ParseUUIDPipe) id: string, @Query('minutes', ParseIntPipe) minutes: number) {
    return this.ticketsService.previewPlannedPrice(id, minutes);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.ticketsService.remove(id);
  }

  @Delete('registrationForDays/:id')
  removeRegistrationForDay(@Param('id') id: string) {
    return this.ticketsService.removeRegistrationForDay(id);
  }


  @Post('ticketsPrice')
  createTicketPrice(@Body() createTicketPriceDto: CreateTicketPriceDto) {
    return this.ticketsService.createTicketPrice(createTicketPriceDto);
  }
  
  @Get('ticketsPrice')
  findAllTicketPrice(@Paginate() query: PaginateQuery): Promise<Paginated<TicketPrice>> {
    return this.ticketsService.findAllTicketPrice(query);
  }

  @Patch('ticketsPrice/:id')
  updateTicketPrice(@Param('id') id: string, @Body() updateTicketPriceDto: UpdateTicketPriceDto) {
    return this.ticketsService.updateTicketPrice(id, updateTicketPriceDto);
  }

  @Delete('ticketsPrice/:id')
  removeTicketPrice(@Param('id') id: string) {
    return this.ticketsService.removeTicketPrice(id);
  }

  @Post('priceBrackets/simulate')
  simulatePrice(@Body() dto: SimulatePriceDto) {
    return this.ticketsService.previewPrice(dto.vehicleType, dto.ticketDayType, dto.elapsedMinutes, dto.entryAt, dto.pricingOptions);
  }

  @Get('priceBrackets/preview')
  previewPrice(@Query() query: PreviewPriceDto) {
    return this.ticketsService.previewPrice(query.vehicleType, query.ticketDayType, Number(query.elapsedMinutes), query.entryAt);
  }

  @Post('priceBrackets')
  createPriceBracket(@Body() createTicketPriceBracketDto: CreateTicketPriceBracketDto) {
    return this.ticketsService.createPriceBracket(createTicketPriceBracketDto);
  }

  @Get('priceBrackets')
  findAllPriceBrackets(@Query('vehicleType') vehicleType?: string): Promise<TicketPriceBracket[]> {
    return this.ticketsService.findAllPriceBrackets(vehicleType);
  }

  @Patch('priceBrackets/:id')
  updatePriceBracket(@Param('id') id: string, @Body() updateTicketPriceBracketDto: UpdateTicketPriceBracketDto) {
    return this.ticketsService.updatePriceBracket(id, updateTicketPriceBracketDto);
  }

  @Delete('priceBrackets/:id')
  removePriceBracket(@Param('id') id: string) {
    return this.ticketsService.removePriceBracket(id);
  }

  @Get('receipt-history')
  receiptHistory(@Query('page') page?: string, @Query('limit') limit?: string, @Query('date') date?: string, @Query('search') search?: string) {
    return this.ticketsService.receiptHistory(listPagination(page, limit), date ?? '', search);
  }

  @Get('registrations')
  findAllRegistrations(@Query('page') page?: string, @Query('limit') limit?: string, @Query('operation') operation?: string) {
    return this.ticketsService.findAllRegistrations(listPagination(page, limit), operation === 'true');
  }

  @Post('registrations/by-plate')
  createRegistrationByPlate(@Req() req: AuthenticatedRequest, @Body() dto: CreateRegistrationByPlateDto) {
    if (!req.user?.userId) throw new UnauthorizedException('Esta acción requiere un usuario autenticado.');
    return this.ticketsService.createRegistrationByPlate(dto, req.user.userId);
  }

  @Get('registrations/plate-status/:plate')
  getPlateStatus(@Param('plate') plate: string) {
    return this.ticketsService.getPlateStatus(plate);
  }

  @Get('registrations/active/search')
  searchActiveRegistrations(@Query('q') q: string) {
    return this.ticketsService.searchActiveRegistrations(q);
  }

  // Lleva `modalidad`: una estadía gratuita vuelve sin importes y sale por PATCH …/salida.
  @Get('registrations/:id/close-summary')
  getCloseSummary(@Param('id') id: string) {
    return this.ticketsService.getResumenSalida(id);
  }

  // Planilla de vehículos (entradas, salidas, presentes, permanencia y operador; sin importes).
  // Declarada antes de `registrations/:id` para que «planilla» no se lea como un id.
  @Get('registrations/planilla')
  planillaVehiculos(
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('estado') estado?: string,
    @Query('operador') operador?: string,
    @Query('tipo') tipo?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ticketsService.planillaVehiculos({ desde, hasta, estado, operador, tipo, q }, listPagination(page, limit));
  }

  // La salida de una estadía que ingresó en modalidad gratuita: sin importes, medio de pago ni caja.
  @Patch('registrations/:id/salida')
  registrarSalida(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.user?.userId) throw new UnauthorizedException('Esta acción requiere un usuario autenticado.');
    return this.ticketsService.registrarSalidaGratuita(id, req.user.userId);
  }

  // Las tarifas que pudo haber pagado si se fue antes, con su importe (ver opcionesSalidaAnterior).
  @Get('registrations/:id/salida-anterior')
  opcionesSalidaAnterior(@Param('id') id: string) {
    return this.ticketsService.opcionesSalidaAnterior(id);
  }

  @Post('registrations/:id/discount')
  discountRegistration(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: DiscountRegistrationDto) {
    if (!req.user?.userId) throw new UnauthorizedException('Esta acción requiere un usuario autenticado.');
    return this.ticketsService.discountRegistration(id, dto, req.user.userId);
  }

  // Pago híbrido con QR o alias: primero la parte en efectivo; el QR o el alias piden el resto.
  @Post('registrations/:id/pago-parcial')
  pagoParcial(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: PagoParcialDto) {
    if (!req.user?.userId) throw new UnauthorizedException('Esta acción requiere un usuario autenticado.');
    return this.ticketsService.cobrarParteEnEfectivo(id, dto, req.user.userId);
  }

  @Patch('registrations/:id/entrada')
  corregirEntrada(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: CorregirEntradaDto) {
    if (!req.user?.userId) throw new UnauthorizedException('Esta acción requiere un usuario autenticado.');
    return this.ticketsService.corregirEntradaOlvidada(id, dto.entrada, req.user.userId);
  }

  // La patente o el tipo de vehículo cargados mal al entrar, desde el cobro (ver corregirDatosEstadia).
  @Patch('registrations/:id/datos')
  corregirDatos(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: CorregirDatosEstadiaDto) {
    if (!req.user?.userId) throw new UnauthorizedException('Esta acción requiere un usuario autenticado.');
    return this.ticketsService.corregirDatosEstadia(id, dto, req.user.userId);
  }

  @Patch('registrations/:id/close')
  closeRegistrationByPlate(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: CloseRegistrationDto,
  ) {
    if (!req.user?.userId) {
      throw new UnauthorizedException('Esta acción requiere un usuario autenticado.');
    }
    return this.ticketsService.closeRegistrationByPlate(id, dto, req.user.userId);
  }

  // «Se fue antes»: cobra lo que correspondía a la hora en que se fue y registra la salida con esa
  // hora (ver registrarSalidaAnterior). Operador incluido; queda en la Actividad (audit-policy).
  @Post('registrations/:id/salida-anterior')
  registrarSalidaAnterior(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: SalidaAnteriorDto) {
    if (!req.user?.userId) throw new UnauthorizedException('Esta acción requiere un usuario autenticado.');
    return this.ticketsService.registrarSalidaAnterior(id, dto, req.user.userId);
  }

  // Una estadía abierta y sin cobros que se cargó por error. Solo el administrador: no está en
  // OPERATOR_ENDPOINTS, y queda en la Actividad (audit-policy).
  @Delete('registrations/:id')
  eliminarEstadia(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!req.user?.userId) {
      throw new UnauthorizedException('Esta acción requiere un usuario autenticado.');
    }
    return this.ticketsService.eliminarEstadiaPorError(id);
  }

  @Get('registrations/summary')
  getTicketRegistrationsSummary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.ticketsService.getTicketRegistrationsSummary(from, to);
  }

  @Get('registrations/hourly-activity')
  getHourlyActivity(@Query('date') date?: string) {
    return this.ticketsService.getHourlyActivity(date);
  }

  @Get('registrations/frequent')
  getFrequentCustomers(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('vehicleType') vehicleType?: string,
    @Query('minVisits') minVisits?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.ticketsService.getFrequentCustomers({
      from,
      to,
      vehicleType,
      minVisits: minVisits ? Number(minVisits) : undefined,
      search,
    }, listPagination(page, limit));
  }

  @Get('registrations/frequent/:plate')
  getPlateHistory(@Param('plate') plate: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.ticketsService.getPlateHistory(plate, listPagination(page, limit));
  }

  @Get('registrations/:id')
  findOne(@Param('id') id: string) {
    return this.ticketsService.findOneRegistration(id);
  }

  @Post('simulation/:barId')
  createRegistrationPrueba(@Param('barId') simulatedCodeBar: string) {
    return this.ticketsService.createRegistration(simulatedCodeBar);
  }
}
