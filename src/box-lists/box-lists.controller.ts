import { Controller, Get, Post, Put, Body, Param, Query, NotFoundException, UseGuards, Delete, Patch } from '@nestjs/common';
import { BoxListsService } from './box-lists.service';
import { CreateBoxListDto } from './dto/create-box-list.dto';
import { UpdateBoxListDto } from './dto/update-box-list.dto';
import { CreateOtherPaymentDto } from './dto/create-other-payment.dto';
import { AuthOrTokenAuthGuard } from 'src/utils/guards/auth-or-token.guard';
import { UpdateOtherPaymentDto } from './dto/update-other-payment.dto';
import { listPagination } from 'src/utils/list-pagination';

@Controller('box-lists')
@UseGuards(AuthOrTokenAuthGuard)
export class BoxListsController {
  constructor(private readonly boxListsService: BoxListsService) {}

  @Post()
  async createBox(@Body() createBoxListDto: CreateBoxListDto) {
    return await this.boxListsService.createBox(createBoxListDto);
  }

  @Delete('otherPayment/:id')
  async removeOtherPayment(@Param('id') id: string) {
    return await this.boxListsService.removeOtherPayment(id);
  }


  @Get()
  async getAllboxes(@Query('page') page?: string, @Query('limit') limit?: string) {
      return await this.boxListsService.getAllboxes(listPagination(page, limit));
  }
    @Get('otherPayment')
  async findAllOtherPayment(@Query('page') page?: string, @Query('limit') limit?: string, @Query('search') search?: string, @Query('sort') sort?: string, @Query('direction') direction?: string) {
    return await this.boxListsService.findAllOtherPayment(listPagination(page, limit), search, sort, direction);
  }

  @Get('summary')
  async getRevenueSummary(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('groupBy') groupBy?: 'day' | 'month',
  ) {
    return await this.boxListsService.getRevenueSummary(from, to, groupBy);
  }

  @Get('otherPayment/summary')
  async getOtherPaymentsSummary(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('groupBy') groupBy?: 'day' | 'month',
  ) {
    return await this.boxListsService.getOtherPaymentsSummary(from, to, groupBy);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
      return await this.boxListsService.findOne(id);
  }

// PATCH /box-lists/update-by-date/:date
@Patch('update-by-date/:date')
async updateBoxByDate(
  @Param('date') date: string,
  @Body() body: { totalPrice: number },
) {
  return await this.boxListsService.updateBoxByDate(date, body.totalPrice);
}


  @Put(':id')
  async updateBox(@Param('id') id: string, @Body() updateBoxListDto: UpdateBoxListDto) {
    return await this.boxListsService.updateBox(id, updateBoxListDto);
  }

  @Get('date/:date')
  async findBoxByDate(@Param('date') date: string) {
    // Validar el formato YYYY-MM-DD con una expresión regular
    const isValidFormat = /^\d{4}-\d{2}-\d{2}$/.test(date);
    if (!isValidFormat) {
      throw new NotFoundException('Invalid date format, expected YYYY-MM-DD');
    }
  
    const boxList = await this.boxListsService.findBoxByDate(date);
    if (!boxList) {
      throw new NotFoundException('BoxList not found for the given date');
    }
  
    return { message: 'BoxList found', data: boxList };
  }
  

  @Post('otherPayment')
  async createOtherPayment(@Body() createOtherPaymentDto: CreateOtherPaymentDto) {
    return await this.boxListsService.createOtherPayment(createOtherPaymentDto);
  }



  @Put('otherPayment/:id')
  async updateOtherPayment(@Param('id') id: string, @Body() updateOtherPaymentDto: UpdateOtherPaymentDto) {
    return await this.boxListsService.updateOtherPayment(id, updateOtherPaymentDto);
  }



}
