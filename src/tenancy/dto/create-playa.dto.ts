import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreatePlayaDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  nombre: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  direccion?: string;

  // Cuántos vehículos entran a la vez; null la deja sin cargar.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  capacidad?: number | null;
}
