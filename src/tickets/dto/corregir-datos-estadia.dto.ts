import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// Corregir la patente o el tipo de vehículo de una estadía abierta, al cobrarla (se cargó mal al
// entrar). Ver TicketsService.corregirDatosEstadia.
export class CorregirDatosEstadiaDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  licensePlate?: string;

  @IsOptional()
  @Matches(/^[A-Z][A-Z0-9_]{0,31}$/)
  vehicleType?: string;
}
