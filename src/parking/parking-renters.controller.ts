import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Paginate, Paginated, PaginateQuery } from 'nestjs-paginate';
import { ParkingRentersService } from './parking-renters.service';
import { AuthOrTokenAuthGuard } from 'src/utils/guards/auth-or-token.guard';
import { UpdateAmountAllCustomerDto } from './dto/update-amount-all-customers.dto';
import { RenterParkingType } from './entities/renter-parking-type.entity';
import { CreateRenterParkingTypeDto } from './dto/create-renter-parking-type.dto';
import { UpdateRenterParkingTypeDto } from './dto/update-renter-parking-type.dto';

@Controller('parking')
@UseGuards(AuthOrTokenAuthGuard)
export class ParkingRentersController {
  constructor(private readonly parkingRentersService: ParkingRentersService) {}

  @Patch('renters/amount')
  updateAmount(@Body() updateAmountAllCustomerDto: UpdateAmountAllCustomerDto) {
    return this.parkingRentersService.updateAmount(updateAmountAllCustomerDto);
  }

  @Post('renter-types')
  createRenterParkingType(@Body() createRenterParkingTypeDto: CreateRenterParkingTypeDto) {
    return this.parkingRentersService.createRenterParkingType(createRenterParkingTypeDto);
  }

  @Get('renter-types')
  findAllRenterParkingType(@Paginate() query: PaginateQuery): Promise<Paginated<RenterParkingType>> {
    return this.parkingRentersService.findAllRenterParkingType(query);
  }

  @Patch('renter-types/:renterParkingTypeId')
  updateRenterParkingType(@Param('renterParkingTypeId') renterParkingTypeId: string, @Body() updateRenterParkingTypeDto: UpdateRenterParkingTypeDto) {
    return this.parkingRentersService.updateRenterParkingType(renterParkingTypeId, updateRenterParkingTypeDto);
  }

  @Delete('renter-types/:renterParkingTypeId')
  removeRenterParkingType(@Param('renterParkingTypeId') renterParkingTypeId: string) {
    return this.parkingRentersService.removeRenterParkingType(renterParkingTypeId);
  }
}
