import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { MOVIMIENTO_METODO, MovimientoMetodo, MOVIMIENTO_TIPO, MovimientoTipo } from '../entities/movimiento.entity';

export class CreateMovimientoDto {
  @IsUUID()
  @IsOptional()
  ticketRegistrationId?: string;

  @IsInt()
  @Min(0)
  @IsNotEmpty()
  monto: number;

  @IsEnum(MOVIMIENTO_METODO)
  @IsNotEmpty()
  metodo: MovimientoMetodo;

  @IsEnum(MOVIMIENTO_TIPO)
  @IsNotEmpty()
  tipo: MovimientoTipo;

  @IsString()
  @IsOptional()
  referencia?: string;

  @IsString()
  @IsOptional()
  motivo?: string;

  // Se completa server-side desde el usuario autenticado — no se toma del body.
  usuarioId?: string;
}
