import { Module } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Customer } from './entities/customer.entity';
import { ReceiptsModule } from 'src/receipts/receipts.module';
import { Receipt } from 'src/receipts/entities/receipt.entity';
import { InterestSettings } from './entities/interest-setting.entity';
import { NotificationGateway } from 'src/notes/notification-gateway';
import { NotificationInterestGateway } from './notification-interest-gateway';
import { ParkingModule } from 'src/parking/parking.module';

@Module({
  imports: [TypeOrmModule.forFeature([Customer, Receipt, InterestSettings]), ReceiptsModule, ParkingModule],
  controllers: [CustomersController],
  providers: [CustomersService, NotificationInterestGateway],
})
export class CustomersModule {}
