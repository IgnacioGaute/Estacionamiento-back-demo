import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CuentaMercadoPago } from './entities/cuenta-mercadopago.entity';
import { CobroMercadoPago } from './entities/cobro-mercadopago.entity';
import { CobroTransferencia } from './entities/cobro-transferencia.entity';
import { CajaMercadoPago } from './entities/caja-mercadopago.entity';
import { TransferenciaRecibida } from './entities/transferencia-recibida.entity';
import { EmpresaAdicional } from 'src/saas/entities/empresa-adicional.entity';
import { MercadoPagoService } from './mercadopago.service';
import { CobrosMercadoPagoService } from './cobros.service';
import { MercadoPagoController } from './mercadopago.controller';
import { CobrosMercadoPagoController } from './cobros.controller';
import { VerificacionAliasController } from './verificacion-alias.controller';
import { VerificacionAliasService } from './verificacion-alias.service';
import { CajasQrService } from './cajas-qr.service';
import { TicketsModule } from 'src/tickets/tickets.module';
import { CuentasModule } from 'src/cuentas/cuentas.module';
import { TurnosModule } from 'src/turnos/turnos.module';
import { ControlTurnoController } from './control-turno.controller';
import { ControlTurnoMercadoPagoService } from './control-turno.service';

// La dependencia va en un solo sentido: MercadoPago conoce a Tickets y a Cuentas, ninguno de los
// dos conoce a MercadoPago. Es lo que evita el ciclo entre módulos y deja el cobro con QR como
// algo que se agrega a la operación sin meterse dentro de ella. EmpresaAdicional es de saas, pero
// acá solo se lee (si la plataforma habilitó la verificación por alias), sin importar el módulo.
// Turnos tampoco conoce a MercadoPago: el control de Mercado Pago al cerrar un turno se engancha
// desde acá (ControlTurnoMercadoPagoService.onModuleInit).
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CuentaMercadoPago,
      CobroMercadoPago,
      CobroTransferencia,
      TransferenciaRecibida,
      CajaMercadoPago,
      EmpresaAdicional,
    ]),
    TicketsModule,
    CuentasModule,
    TurnosModule,
  ],
  controllers: [
    MercadoPagoController,
    CobrosMercadoPagoController,
    VerificacionAliasController,
    ControlTurnoController,
  ],
  providers: [
    MercadoPagoService,
    CobrosMercadoPagoService,
    VerificacionAliasService,
    CajasQrService,
    ControlTurnoMercadoPagoService,
  ],
  exports: [MercadoPagoService],
})
export class MercadoPagoModule {}
