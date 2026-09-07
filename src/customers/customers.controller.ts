import { Controller, Get, Post, Body, Patch, Param, Query, Delete, UseGuards } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CustomerType } from './entities/customer.entity';
import { CreateInterestSettingDto } from './dto/interest-setting.dto';
import { AuthOrTokenAuthGuard } from 'src/utils/guards/auth-or-token.guard';


@Controller('customers')
@UseGuards(AuthOrTokenAuthGuard)
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Post()
  create(@Body() createCustomerDto?: CreateCustomerDto) {
    return this.customersService.create(createCustomerDto);
  }

  @Get('customer/:customerType')
  findAll(@Param('customerType') customer: CustomerType) {
    return this.customersService.findAll(customer);
  }

  @Get('thirds')
  async getCustomerthird() {
    return await this.customersService.getCustomerthird();
  }

  @Get('summary')
  async getCustomersSummary(@Query('from') from?: string, @Query('to') to?: string) {
    return await this.customersService.getCustomersSummary(from, to);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.customersService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateCustomerDto: UpdateCustomerDto) {
    return this.customersService.update(id, updateCustomerDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.customersService.remove(id);
  }

  @Delete('softDelete/:id')
  softDelete(@Param('id') id: string) {
    return this.customersService.softDelete(id);
  }

  @Patch('restoredCustomer/:id')
  restoredCustomer(@Param('id') id: string) {
    return this.customersService.restoredCustomer(id);
  }

  @Post('interestSetting')
  async createInterest(@Body() createInterestSettingDto: CreateInterestSettingDto) {
    return await this.customersService.createInterest(createInterestSettingDto);
  }

  @Get('interestSetting/interest')
  async findInterest() {
    return await this.customersService.findInterest();
  }
}
