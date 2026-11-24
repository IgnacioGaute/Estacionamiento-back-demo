import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TicketsModule } from 'src/tickets/tickets.module';
import { TicketsService } from 'src/tickets/tickets.service';
import { MovimientosModule } from 'src/movimientos/movimientos.module';
import { MovimientosService } from 'src/movimientos/movimientos.service';
import { BoxListsModule } from 'src/box-lists/box-lists.module';
import { BoxListsService } from 'src/box-lists/box-lists.service';
import { MercadoPagoModule } from 'src/mercadopago/mercadopago.module';
import { VerificacionAliasService } from 'src/mercadopago/verificacion-alias.service';
import { Correccion } from './entities/correccion.entity';
import { CorreccionesService } from './correcciones.service';
import { HistorialService } from './historial.service';
import { OperacionesController } from './operaciones.controller';

// Depende de Tickets, Movimientos, Caja y MercadoPago; ninguno depende de este módulo.
@Module({
  imports: [TypeOrmModule.forFeature([Correccion]), TicketsModule, MovimientosModule, BoxListsModule, MercadoPagoModule],
  controllers: [OperacionesController],
  providers: [
    HistorialService,
    {
      provide: CorreccionesService,
      inject: [DataSource, MovimientosService, BoxListsService, TicketsService, VerificacionAliasService],
      useFactory: (ds: DataSource, movimientos: MovimientosService, cajas: BoxListsService, tickets: TicketsService, verificacion: VerificacionAliasService) =>
        new CorreccionesService(ds, movimientos, cajas, tickets, verificacion),
    },
  ],
})
export class OperacionesModule {}
