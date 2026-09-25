import { IsIn, IsOptional, IsUUID } from 'class-validator';

// El importe no viaja en el pedido a propósito: lo calcula el servidor desde el resumen de cierre
// o desde el precio del abono. Si lo mandara el mostrador, un pedido manipulado podría cobrar
// cualquier cosa.
export class CrearCobroDto {
  @IsUUID()
  registrationId: string;

  // HORA: estadía que se cobra al salir. ABONO: día, semana o mes, que se paga por adelantado y
  // vive en otra tabla. Sin especificar, es una estadía por hora.
  @IsIn(['HORA', 'ABONO'])
  @IsOptional()
  tipo?: 'HORA' | 'ABONO';
}
