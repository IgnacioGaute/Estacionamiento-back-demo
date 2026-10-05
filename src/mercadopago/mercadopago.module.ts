import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CuentaMercadoPago } from './entities/cuenta-mercadopago.entity';
import { CobroMercadoPago } from './entities/cobro-mercadopago.entity';
import { MercadoPagoService } from './mercadopago.service';
import { CobrosMercadoPagoService } from './cobros.service';
import { MercadoPagoController } from './mercadopago.controller';
import { CobrosMercadoPagoController } from './cobros.controller';
import { DiagnosticoMercadoPagoController } from './diagnostico.controller';
import { PruebaTransferenciasService } from './prueba-transferencias.service';
import { TicketsModule } from 'src/tickets/tickets.module';
import { CuentasModule } from 'src/cuentas/cuentas.module';
import { User } from 'src/users/entities/user.entity';

// La dependencia va en un solo sentido: MercadoPago conoce a Tickets y a Cuentas, ninguno de los
// dos conoce a MercadoPago. Es lo que evita el ciclo entre módulos y deja el cobro con QR como
// algo que se agrega a la operación sin meterse dentro de ella.
@Module({
  imports: [
    // User, para el SuperAdminGuard de la prueba de transferencias.
    TypeOrmModule.forFeature([CuentaMercadoPago, CobroMercadoPago, User]),
    TicketsModule,
    CuentasModule,
  ],
  controllers: [
    MercadoPagoController,
    CobrosMercadoPagoController,
    DiagnosticoMercadoPagoController,
  ],
  providers: [
    MercadoPagoService,
    CobrosMercadoPagoService,
    PruebaTransferenciasService,
  ],
  exports: [MercadoPagoService],
})
export class MercadoPagoModule {}
