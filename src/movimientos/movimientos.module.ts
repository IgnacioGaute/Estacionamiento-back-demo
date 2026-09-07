import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Movimiento } from './entities/movimiento.entity';
import { MovimientosService } from './movimientos.service';
import { TurnosModule } from 'src/turnos/turnos.module';

@Module({
  imports: [TypeOrmModule.forFeature([Movimiento]), TurnosModule],
  providers: [MovimientosService],
  exports: [MovimientosService],
})
export class MovimientosModule {}
