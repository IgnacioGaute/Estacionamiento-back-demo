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
import { PruebaTransferenciasController } from './prueba-transferencias.controller';
import { PruebaTransferenciasService } from './prueba-transferencias.service';
import { VerificacionAliasController } from './verificacion-alias.controller';
import { VerificacionAliasService } from './verificacion-alias.service';
import { CajasQrService } from './cajas-qr.service';
import { TicketsModule } from 'src/tickets/tickets.module';
import { CuentasModule } from 'src/cuentas/cuentas.module';

// La dependencia va en un solo sentido: MercadoPago conoce a Tickets y a Cuentas, ninguno de los
// dos conoce a MercadoPago. Es lo que evita el ciclo entre módulos y deja el cobro con QR como
// algo que se agrega a la operación sin meterse dentro de ella. EmpresaAdicional es de saas, pero
// acá solo se lee (si la plataforma habilitó la verificación por alias), sin importar el módulo.
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
  ],
  controllers: [
    MercadoPagoController,
    CobrosMercadoPagoController,
    PruebaTransferenciasController,
    VerificacionAliasController,
  ],
  providers: [
    MercadoPagoService,
    CobrosMercadoPagoService,
    PruebaTransferenciasService,
    VerificacionAliasService,
    CajasQrService,
  ],
  exports: [MercadoPagoService],
})
export class MercadoPagoModule {}
