import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReceiptsModule } from 'src/receipts/receipts.module';
import { BoxListsModule } from 'src/box-lists/box-lists.module';
import { CuentaMovimiento } from './entities/cuenta-movimiento.entity';
import { CuentasService } from './cuentas.service';
import { CuentasController } from './cuentas.controller';

@Module({
  imports: [TypeOrmModule.forFeature([CuentaMovimiento]), ReceiptsModule, BoxListsModule],
  controllers: [CuentasController],
  providers: [CuentasService],
  exports: [CuentasService],
})
export class CuentasModule {}
