import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CloseTurnoDto {
  @IsOptional() @IsInt() @Min(0) sueldoEsperado?: number;
  // El operador elige no retirar su sueldo aunque el efectivo alcance: el cierre no registra el
  // movimiento SUELDO y el historial lo deja anotado (sueldoEsperado debe venir en 0).
  @IsOptional() @IsBoolean() sinSueldo?: boolean;
  @IsBoolean() @IsOptional() cerrarCaja?: boolean;
  @IsInt()
  @Min(0)
  @IsOptional()
  efectivoContado?: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  efectivoParaSiguiente?: number;

  @IsInt()
  @IsOptional()
  efectivoEsperado?: number;

  // Arqueo final: el primer importe que el operador confirmó, antes de ver lo esperado.
  @IsInt() @Min(0) @IsOptional() primerConteo?: number;

  // Deja una caja compartida que sigue abierta: cuenta el cajón (conteo de relevo). Una
  // diferencia exige motivoConteoRelevo.
  @IsInt() @Min(0) @IsOptional() conteoRelevo?: number;
  @IsString() @MaxLength(255) @IsOptional() motivoConteoRelevo?: string;

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
