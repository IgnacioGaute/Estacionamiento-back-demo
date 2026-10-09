import {
  IsBoolean,
  IsArray,
  IsInt,
  ArrayMaxSize,
  Max,
  Min,
  ValidateIf,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

// Para las estadías, el importe sale del resumen de cierre del servidor. Los inquilinos
// permiten un importe elegido por el mostrador, igual que los pagos parciales y anticipos.
export class IniciarCobroAliasDto {
  @IsUUID()
  registrationId: string;

  @IsOptional()
  @IsIn(['HORA', 'ABONO', 'INQUILINO'])
  tipo?: 'HORA' | 'ABONO' | 'INQUILINO';

  // Un inquilino puede pagar una parte o dejar saldo a favor: el mostrador decide el importe.
  @ValidateIf((dto: IniciarCobroAliasDto) => dto.tipo === 'INQUILINO')
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  monto?: number;

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

// La operación que el operador eligió entre las opciones. El servidor verifica que sea una de las
// candidatas de ese cobro (importe, moneda, período) y que nadie la haya usado.
export class AsignarTransferenciaDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  operacionId: string;
}

// Configuración de la empresa: activar la verificación y el alias que les da a sus clientes. Un
// alias de MercadoPago tiene entre 6 y 20 caracteres: letras, números, puntos y guiones.
export class ConfigurarVerificacionAliasDto {
  @IsBoolean()
  activa: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9.-]{6,20}$/, {
    message:
      'El alias tiene entre 6 y 20 caracteres: letras, números, puntos o guiones.',
  })
  alias?: string;
}
