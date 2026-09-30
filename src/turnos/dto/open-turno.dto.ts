import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
export class OpenTurnoDto {
  @IsInt() @Min(0) @IsNotEmpty() fondoInicial: number;
  // Compatibilidad con clientes anteriores; el servidor siempre usa el nombre del usuario.
  @IsString() @MaxLength(80) @IsOptional() nombre?: string;
  @IsInt() @Min(1) @Max(168) @IsOptional() duracionPrevistaHoras?: number;
  @IsUUID() @IsOptional() turnoAnteriorId?: string;
}
