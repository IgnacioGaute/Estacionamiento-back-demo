import { IsIn } from 'class-validator';
import { ORIGEN_REGISTRO, OrigenRegistro } from '../entities/ticket-registration.entity';

// Cómo se inició la salida de una estadía: se anota al abrir su cobro (ver marcarOrigenSalida).
export class OrigenSalidaDto {
  @IsIn(ORIGEN_REGISTRO)
  origen: OrigenRegistro;
}
