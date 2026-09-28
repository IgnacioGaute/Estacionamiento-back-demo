import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf } from 'class-validator';

// Para estadías y abonos el importe no viaja en el pedido a propósito: lo calcula el servidor
// desde el resumen de cierre o desde el precio del abono. Si lo mandara el mostrador, un pedido
// manipulado podría cobrar cualquier cosa.
//
// Un inquilino es distinto: puede pagar una parte, varios meses o de más (queda a favor), así que
// el importe lo decide el mostrador. Lo que se asienta igual es lo que MercadoPago dice que entró.
export class CrearCobroDto {
  // Estadía o abono: su id. Inquilino: el id del cliente.
  @IsUUID()
  registrationId: string;

  // HORA: estadía que se cobra al salir. ABONO: día, semana o mes, que se paga por adelantado y
  // vive en otra tabla. INQUILINO: un pago a la cuenta corriente. Sin especificar, es por hora.
  @IsIn(['HORA', 'ABONO', 'INQUILINO'])
  @IsOptional()
  tipo?: 'HORA' | 'ABONO' | 'INQUILINO';

  @ValidateIf((dto: CrearCobroDto) => dto.tipo === 'INQUILINO')
  @Type(() => Number)
  @IsInt({ message: 'Los importes van en pesos enteros, sin centavos.' })
  @Min(1)
  @Max(1_000_000_000)
  monto?: number;

  // Solo inquilino: los cargos a cubrir primero, en ese orden.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @IsUUID('all', { each: true })
  receiptIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(255)
  nota?: string;
}
