import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Turno } from './entities/turno.entity';
import { Movimiento } from 'src/movimientos/entities/movimiento.entity';
import { TurnosService } from './turnos.service';
import { TurnosController } from './turnos.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Turno, Movimiento])],
  controllers: [TurnosController],
  providers: [TurnosService],
  exports: [TurnosService],
})
export class TurnosModule {}
