import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

// Abrir la espera de una transferencia: solo la estadía. El importe lo calcula el servidor con el
// resumen de cierre; si lo mandara el mostrador, un pedido manipulado podría esperar cualquier cosa.
export class IniciarCobroAliasDto {
  @IsUUID()
  registrationId: string;

  @IsOptional()
  @IsIn(['HORA', 'ABONO'])
  tipo?: 'HORA' | 'ABONO';
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
