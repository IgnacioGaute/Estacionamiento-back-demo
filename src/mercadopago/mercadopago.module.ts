import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CuentaMercadoPago } from './entities/cuenta-mercadopago.entity';
import { CobroMercadoPago } from './entities/cobro-mercadopago.entity';
import { MercadoPagoService } from './mercadopago.service';
import { CobrosMercadoPagoService } from './cobros.service';
import { MercadoPagoController } from './mercadopago.controller';
import { CobrosMercadoPagoController } from './cobros.controller';
import { TicketsModule } from 'src/tickets/tickets.module';

// La dependencia va en un solo sentido: MercadoPago conoce a Tickets, Tickets no conoce a
// MercadoPago. Es lo que evita el ciclo entre módulos y deja el cobro con QR como algo que se
// agrega a la operación sin meterse dentro de ella.
@Module({
  imports: [
    TypeOrmModule.forFeature([CuentaMercadoPago, CobroMercadoPago]),
    TicketsModule,
  ],
  controllers: [MercadoPagoController, CobrosMercadoPagoController],
  providers: [MercadoPagoService, CobrosMercadoPagoService],
  exports: [MercadoPagoService],
})
export class MercadoPagoModule {}
