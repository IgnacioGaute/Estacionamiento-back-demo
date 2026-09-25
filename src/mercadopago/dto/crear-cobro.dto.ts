import { IsUUID } from 'class-validator';

// El importe no viaja en el pedido a propósito: lo calcula el servidor desde el resumen de cierre.
// Si lo mandara el mostrador, un pedido manipulado podría cobrar cualquier cosa.
export class CrearCobroDto {
  @IsUUID()
  registrationId: string;
}
