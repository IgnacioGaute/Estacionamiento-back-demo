import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// La versión de las condiciones (condiciones.ts) que el admin leyó y aceptó. Viaja al conectar la
// cuenta y al aceptar unas nuevas con la cuenta ya conectada; el servidor la compara con la
// vigente y rechaza cualquier otra.
export class AceptarCondicionesDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  condiciones: string;
}
