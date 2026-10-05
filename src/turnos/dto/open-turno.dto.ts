import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
export class OpenTurnoDto {
  @IsInt() @Min(0) @IsNotEmpty() fondoInicial: number;
  // Compatibilidad con clientes anteriores; el servidor siempre usa el nombre del usuario.
  @IsString() @MaxLength(80) @IsOptional() nombre?: string;
  @IsInt() @Min(1) @Max(168) @IsOptional() duracionPrevistaHoras?: number;
  @IsUUID() @IsOptional() turnoAnteriorId?: string;
  @IsUUID() @IsOptional() cajaId?: string;
  @IsUUID() @IsOptional() sesionAnteriorId?: string;
  @IsUUID() @IsOptional() sesionActivaId?: string;
  @IsInt() @Min(0) @IsOptional() cambioAgregado?: number;
  @IsString() @MaxLength(255) @IsOptional() motivoApertura?: string;
}
