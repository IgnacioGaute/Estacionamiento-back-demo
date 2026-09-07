import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ParkingOwner } from './entities/parking-owner.entity';
import { ParkingRenter } from './entities/parking-renter.entity';
import { OwnerParkingType } from './entities/owner-parking-type.entity';
import { RenterParkingType } from './entities/renter-parking-type.entity';
import { Customer } from 'src/customers/entities/customer.entity';
import { Receipt } from 'src/receipts/entities/receipt.entity';
import { ParkingOwnersService } from './parking-owners.service';
import { ParkingRentersService } from './parking-renters.service';
import { ParkingOwnersController } from './parking-owners.controller';
import { ParkingRentersController } from './parking-renters.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ParkingOwner,
      ParkingRenter,
      OwnerParkingType,
      RenterParkingType,
      Customer,
      Receipt,
    ]),
  ],
  controllers: [ParkingOwnersController, ParkingRentersController],
  providers: [ParkingOwnersService, ParkingRentersService],
  exports: [ParkingOwnersService, ParkingRentersService],
})
export class ParkingModule {}
