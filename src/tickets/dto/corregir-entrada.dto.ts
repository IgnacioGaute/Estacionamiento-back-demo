import { IsISO8601 } from 'class-validator';

// El momento real en que entró el vehículo, cuando la entrada se cargó tarde (el operador creyó
// haberla registrado y la cargó recién al cobrar). Ver TicketsService.corregirEntradaOlvidada.
export class CorregirEntradaDto {
  @IsISO8601({ strict: true })
  entrada: string;
}
