import { Module } from '@nestjs/common';
import { ParkingReceiptsService } from './parking-receipts.service';
import { PublicParkingReceiptsController } from './public-parking-receipts.controller';
import { TicketsService } from './tickets.service';
import { OfflineService } from './offline.service';
import { TicketsController } from './tickets.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ticket } from './entities/ticket.entity';
import { TicketRegistration } from './entities/ticket-registration.entity';
import { BoxListsModule } from 'src/box-lists/box-lists.module';
import { TicketGateway } from './register-gateway';
import { TicketRegistrationForDay } from './entities/ticket-registration-for-day.entity';
import { TicketPrice } from './entities/ticket-price.entity';
import { TicketPriceBracket } from './entities/ticket-price-bracket.entity';
import { TicketScheduleSettings } from './entities/ticket-schedule-settings.entity';
import { MovimientosModule } from 'src/movimientos/movimientos.module';

@Module({
  imports: [TypeOrmModule.forFeature([Ticket, TicketRegistration, TicketRegistrationForDay, TicketPrice, TicketPriceBracket, TicketScheduleSettings]), BoxListsModule, MovimientosModule],
  controllers: [TicketsController, PublicParkingReceiptsController],
  providers: [TicketsService, TicketGateway, ParkingReceiptsService, OfflineService],
  exports: [TicketsService]
})
export class TicketsModule {}
