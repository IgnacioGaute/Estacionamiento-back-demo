import { Controller, Get, Param, Post, Body, Patch, Query, UseGuards, Delete } from '@nestjs/common';
import { ReceiptsService } from './receipts.service';
import { UpdateReceiptDto } from './dto/update-receipt.dto';
import { CustomerType } from 'src/customers/entities/customer.entity';
import { AuthOrTokenAuthGuard } from 'src/utils/guards/auth-or-token.guard';
import { listPagination } from 'src/utils/list-pagination';

@Controller('receipts')
@UseGuards(AuthOrTokenAuthGuard)
export class ReceiptsController {
    constructor(private readonly receiptsService: ReceiptsService) {}
 
    @Patch(':receiptId/customers/:customerId')
    async updateByOwner(
        @Param('customerId') customerId: string,
        @Param('receiptId') receiptId: string,
        @Body() updateReceiptDto : UpdateReceiptDto,
    ) {
        return await this.receiptsService.updateReceipt(receiptId, customerId, updateReceiptDto);
    }

    @Patch('cancelReceipt/:receiptId/customers/:customerId')
    async cancelReceiptByOwner(
        @Param('customerId') customerId: string,
        @Param('receiptId') receiptId: string
    ) {
        return await this.receiptsService.cancelReceipt(receiptId, customerId);
    }

    @Get('summary')
    @UseGuards(AuthOrTokenAuthGuard)
    async getReceiptsSummary(@Query('from') from?: string, @Query('to') to?: string) {
        return await this.receiptsService.getReceiptsSummary(from, to);
    }

    @Get(':customerType')
    async findAllPendingReceipts(@Param('customerType') customer: CustomerType, @Query('page') page?: string, @Query('limit') limit?: string, @Query('month') month?: string) {
        return await this.receiptsService.findAllPendingReceipts(customer, listPagination(page, limit), month);
    }

    @Get()
    async findReceipts(@Query('page') page?: string, @Query('limit') limit?: string) {
        return await this.receiptsService.findReceipts(listPagination(page, limit));
    }


  @Post('generate-manual/:customerType')
  async generateReceiptsManual(@Param('customerType') customer: CustomerType, @Body() body: { dateNow: string }) {
    const { dateNow } = body;

    if (!dateNow) {
      throw new Error('Debe enviar una fecha válida en el cuerpo de la solicitud.');
    }

    await this.receiptsService.createReceiptMan(dateNow, customer);

    return {
      message: `Recibos generados (si faltaban) para el mes de ${dateNow}`,
    };
  }

  @Delete(':receiptId')
    async deleteReceipt(
        @Param('receiptId') receiptId: string
    ) {
        return await this.receiptsService.deleteReceipt(receiptId);
    }
}
