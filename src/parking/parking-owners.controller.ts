import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards, Query } from '@nestjs/common';
import { listPagination } from 'src/utils/list-pagination';
import { Paginate, Paginated, PaginateQuery } from 'nestjs-paginate';
import { ParkingOwnersService } from './parking-owners.service';
import { AuthOrTokenAuthGuard } from 'src/utils/guards/auth-or-token.guard';
import { OwnerParkingType } from './entities/owner-parking-type.entity';
import { CreateOwnerParkingTypeDto } from './dto/create-owner-parking-type.dto';
import { UpdateOwnerParkingTypeDto } from './dto/update-owner-parking-type.dto';

@Controller('parking')
@UseGuards(AuthOrTokenAuthGuard)
export class ParkingOwnersController {
  constructor(private readonly parkingOwnersService: ParkingOwnersService) {}

  @Get('owners/for-rent')
  async getOwnersAvailableForRent(@Query('page') page?: string, @Query('limit') limit?: string) {
    return await this.parkingOwnersService.getOwnersAvailableForRent(listPagination(page, limit));
  }

  @Get('owners/occupancy-summary')
  async getOccupancySummary() {
    return await this.parkingOwnersService.getOccupancySummary();
  }

  @Post('owner-types')
  createOwnerParkingType(@Body() createOwnerParkingTypeDto: CreateOwnerParkingTypeDto) {
    return this.parkingOwnersService.createOwnerParkingType(createOwnerParkingTypeDto);
  }

  @Get('owner-types')
  findAllOwnerParkingType(@Paginate() query: PaginateQuery): Promise<Paginated<OwnerParkingType>> {
    return this.parkingOwnersService.findAllOwnerParkingType(query);
  }

  @Patch('owner-types/:parkingTypeId')
  updateOwnerParkingType(@Param('parkingTypeId') parkingTypeId: string, @Body() updateOwnerParkingTypeDto: UpdateOwnerParkingTypeDto) {
    return this.parkingOwnersService.updateOwnerParkingType(parkingTypeId, updateOwnerParkingTypeDto);
  }

  @Delete('owner-types/:parkingTypeId')
  removeOwnerParkingType(@Param('parkingTypeId') parkingTypeId: string) {
    return this.parkingOwnersService.removeOwnerParkingType(parkingTypeId);
  }
}
