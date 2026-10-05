import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
export class CajaDto {
  @IsString() @MinLength(1) @MaxLength(80) nombre: string;
  @IsBoolean() @IsOptional() activa?: boolean;
}
export class CashSessionMovementDto {
  @IsIn(['APORTE', 'RETIRO']) tipo: 'APORTE' | 'RETIRO';
  @IsInt() @Min(1) importe: number;
  @IsInt() efectivoEsperado: number;
  @IsString() @MinLength(1) @MaxLength(255) motivo: string;
}
