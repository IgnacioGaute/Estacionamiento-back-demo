import { Module } from '@nestjs/common';
import { ReceiptsService } from './receipts.service';
import { ReceiptsController } from './receipts.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BoxListsModule } from 'src/box-lists/box-lists.module';
import { Customer } from 'src/customers/entities/customer.entity';
import { Receipt } from './entities/receipt.entity';
import { ReceiptPayment } from './entities/receipt-payment.entity';
import { PaymentHistoryOnAccount } from './entities/payment-history-on-account.entity';
import { Movimiento } from 'src/movimientos/entities/movimiento.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Customer, Receipt, ReceiptPayment, PaymentHistoryOnAccount, Movimiento]), BoxListsModule],
  controllers: [ReceiptsController],
  providers: [ReceiptsService],
  exports: [ReceiptsService]
})
export class ReceiptsModule {}
