import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsIn, IsInt, Max, Min, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';
import { MOVIMIENTO_METODO_MANUAL, MovimientoMetodoManual } from 'src/movimientos/entities/movimiento.entity';

export const CLOSE_TYPE = ['PAYMENT', 'NO_CHARGE', 'COURTESY'] as const;
export type CloseType = (typeof CLOSE_TYPE)[number];

// Una parte del cobro con un medio (ver CloseRegistrationDto.pagos).
export class PagoSalidaDto {
  @IsEnum(MOVIMIENTO_METODO_MANUAL)
  metodo: MovimientoMetodoManual;

  @IsInt({ message: 'Los importes van en pesos enteros, sin centavos.' })
  @Min(1)
  @Max(1_000_000_000)
  importe: number;
}

export class CloseRegistrationDto {
  @IsInt()
  @Min(0)
  expectedPrice: number;

  @IsInt()
  @Min(0)
  expectedCollected: number;

  @IsEnum(MOVIMIENTO_METODO_MANUAL)
  @IsOptional()
  refundMetodo?: MovimientoMetodoManual;

  @IsIn(CLOSE_TYPE)
  @IsNotEmpty()
  closeType: CloseType;

  // Obligatorio cuando closeType es PAYMENT (verificado en el servicio), salvo que venga `pagos`.
  @IsEnum(MOVIMIENTO_METODO_MANUAL)
  @IsOptional()
  metodo?: MovimientoMetodoManual;

  // Pago híbrido, como en la cuenta de un inquilino: el saldo repartido entre efectivo y
  // transferencia. Tiene que sumar el saldo exacto y reemplaza a `metodo`.
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => PagoSalidaDto)
  pagos?: PagoSalidaDto[];

  @IsString()
  @IsOptional()
  referencia?: string;

  // Obligatorio cuando closeType es COURTESY (verificado en el servicio).
  @IsString()
  @IsOptional()
  motivo?: string;
}
