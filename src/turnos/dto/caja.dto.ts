import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
export class CajaDto {
  @IsOptional() @IsInt() @Min(0) @Max(100000000) fondoObjetivo?: number;
  @IsString() @MinLength(1) @MaxLength(80) nombre: string;
  @IsBoolean() @IsOptional() activa?: boolean;
}
export class CashSessionMovementDto {
  @IsIn(['APORTE', 'RETIRO']) tipo: 'APORTE' | 'RETIRO';
  @IsInt() @Min(1) importe: number;
  @IsInt() efectivoEsperado: number;
  @IsString() @MinLength(1) @MaxLength(255) motivo: string;
}
