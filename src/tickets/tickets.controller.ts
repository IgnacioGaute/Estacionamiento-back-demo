import { CreateVehicleTypeDto, UpdateVehicleTypeDto } from './dto/vehicle-type.dto';
import { Controller, Get, Post, Body, Patch, Param, Query, Delete, UseGuards, Req, UnauthorizedException } from '@nestjs/common';
import { AuthenticatedRequest } from 'src/types/request';
import { CreateRegistrationByPlateDto } from './dto/create-registration-by-plate.dto';
import { CloseRegistrationDto } from './dto/close-registration.dto';
import { PreviewPriceDto, SimulatePriceDto } from './dto/preview-price.dto';
import { TicketsService } from './tickets.service';
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
import { TicketRegistrationForDay } from './entities/ticket-registration-for-day.entity';
import { UpdateTicketScheduleDto } from './dto/update-ticket-schedule.dto';
import { CreateTicketRegistrationForDayDto, UpdateTicketStatusDto } from './dto/create-ticket-registration-for-day.dto';

@Controller('tickets')
@UseGuards(AuthOrTokenAuthGuard)
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService, private readonly parkingReceipts: ParkingReceiptsService, private readonly offline: OfflineService) {}

  @Post('offline/prepare')
  prepareOffline(@Body() dto: OfflineDeviceDto) { return this.offline.prepare(dto.deviceId); }
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
  findAllRegistrationForDay() {
    return this.ticketsService.findAllRegistrationForDay();
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
    return this.ticketsService.createRegistrationForDay(createTicketRegistrationForDayDto);
  }

  // Va antes de `registrationForDays/:id/status` para que "retire-many" no entre como un id.
  @Patch('registrationForDays/retire-many')
  retireRegistrationsForDay(@Body('ids') ids: string[]) {
    return this.ticketsService.retireRegistrationsForDay(ids);
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
    return this.ticketsService.updateTicketStatus(id, dto);
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

  @Get('registrations')
  findAllRegistrations() {
    return this.ticketsService.findAllRegistrations();
  }

  @Post('registrations/by-plate')
  createRegistrationByPlate(@Body() dto: CreateRegistrationByPlateDto) {
    return this.ticketsService.createRegistrationByPlate(dto);
  }

  @Get('registrations/active/search')
  searchActiveRegistrations(@Query('q') q: string) {
    return this.ticketsService.searchActiveRegistrations(q);
  }

  @Get('registrations/:id/close-summary')
  getCloseSummary(@Param('id') id: string) {
    return this.ticketsService.getCloseSummary(id);
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
  ) {
    return this.ticketsService.getFrequentCustomers({
      from,
      to,
      vehicleType,
      minVisits: minVisits ? Number(minVisits) : undefined,
    });
  }

  @Get('registrations/frequent/:plate')
  getPlateHistory(@Param('plate') plate: string) {
    return this.ticketsService.getPlateHistory(plate);
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
