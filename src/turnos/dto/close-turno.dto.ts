import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CloseTurnoDto {
  @IsInt()
  @Min(0)
  @IsNotEmpty()
  efectivoContado: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  efectivoParaSiguiente?: number;

  @IsInt()
  @IsOptional()
  efectivoEsperado?: number;

  @IsString()
  @IsOptional()
  observaciones?: string;

  // Solo lo manda un admin que cierra el turno de otro. Obligatorio en ese caso: se valida en
  // TurnosService.close, no acá, porque depende de quién sea el que llama.
  @IsString()
  @MaxLength(255)
  @IsOptional()
  motivoCierreForzado?: string;
}
