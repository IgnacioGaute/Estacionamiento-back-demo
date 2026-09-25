import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CuentaMercadoPago } from './entities/cuenta-mercadopago.entity';
import { MercadoPagoService } from './mercadopago.service';
import { MercadoPagoController } from './mercadopago.controller';

// Se exporta el servicio porque el cobro (tickets) va a pedirle el token de la empresa.
@Module({
  imports: [TypeOrmModule.forFeature([CuentaMercadoPago])],
  controllers: [MercadoPagoController],
  providers: [MercadoPagoService],
  exports: [MercadoPagoService],
})
export class MercadoPagoModule {}
