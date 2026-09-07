import { IsEnum, IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { MOVIMIENTO_METODO, MovimientoMetodo } from 'src/movimientos/entities/movimiento.entity';

export const CLOSE_TYPE = ['PAYMENT', 'NO_CHARGE', 'COURTESY'] as const;
export type CloseType = (typeof CLOSE_TYPE)[number];

export class CloseRegistrationDto {
  @IsIn(CLOSE_TYPE)
  @IsNotEmpty()
  closeType: CloseType;

  // Obligatorio cuando closeType es PAYMENT (verificado en el servicio).
  @IsEnum(MOVIMIENTO_METODO)
  @IsOptional()
  metodo?: MovimientoMetodo;

  @IsString()
  @IsOptional()
  referencia?: string;

  // Obligatorio cuando closeType es COURTESY (verificado en el servicio).
  @IsString()
  @IsOptional()
  motivo?: string;
}
