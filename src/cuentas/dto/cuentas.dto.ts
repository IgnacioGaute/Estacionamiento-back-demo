import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CUENTA_METODO_MANUAL, CuentaMetodoManual } from '../entities/cuenta-movimiento.entity';

const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const FECHA = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
// Importes en pesos enteros, como el resto de la caja.
const MAXIMO = 1_000_000_000;
const ENTEROS = { message: 'Los importes van en pesos enteros, sin centavos.' };

export class PagoItemDto {
  // Efectivo o transferencia: el cheque ya no se recibe y MercadoPago se acredita solo.
  @IsIn(CUENTA_METODO_MANUAL, { message: 'El medio tiene que ser efectivo o transferencia.' })
  metodo: CuentaMetodoManual;

  @IsInt(ENTEROS)
  @Min(1)
  @Max(MAXIMO)
  importe: number;
}

export class RegistrarPagoDto {
  // Un cobro puede combinar medios (parte en efectivo, parte por transferencia).
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => PagoItemDto)
  pagos: PagoItemDto[];

  // Recibos a los que imputar primero, en ese orden. Sin esto, del más viejo al más nuevo.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @IsUUID('all', { each: true })
  receiptIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(255)
  nota?: string;

  // Lo genera la pantalla al abrir el cobro y lo repite si reintenta: el mismo identificador
  // nunca registra dos cobros (ver CuentasService.registrarPago).
  @IsUUID('all', { message: 'Falta el identificador del cobro.' })
  solicitudId: string;
}

export class MesDeudaDto {
  @Matches(MES, { message: 'El mes tiene que tener el formato AAAA-MM.' })
  mes: string;

  @IsInt(ENTEROS)
  @Min(1)
  @Max(MAXIMO)
  importe: number;
}

export class SaldoInicialDto {
  @IsIn(['AL_DIA', 'DEUDA', 'A_FAVOR'])
  tipo: 'AL_DIA' | 'DEUDA' | 'A_FAVOR';

  // Deuda: un solo importe a una fecha de corte, o detallada mes por mes.
  @IsOptional()
  @IsIn(['TOTAL', 'POR_MES'])
  modo?: 'TOTAL' | 'POR_MES';

  @IsOptional()
  @IsInt(ENTEROS)
  @Min(1)
  @Max(MAXIMO)
  importe?: number;

  @IsOptional()
  @Matches(FECHA, { message: 'La fecha tiene que tener el formato AAAA-MM-DD.' })
  fecha?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => MesDeudaDto)
  meses?: MesDeudaDto[];

  @IsOptional()
  @IsString()
  @MaxLength(255)
  nota?: string;
}

export class AjusteDto {
  // Bonificación baja la deuda (descuento, corrección a favor); recargo la sube y genera un
  // cargo propio para poder cobrarlo.
  @IsIn(['BONIFICACION', 'RECARGO'])
  tipo: 'BONIFICACION' | 'RECARGO';

  @IsInt(ENTEROS)
  @Min(1)
  @Max(MAXIMO)
  importe: number;

  @IsString()
  @MinLength(3)
  @MaxLength(255)
  motivo: string;

  @IsOptional()
  @IsUUID('all')
  receiptId?: string;
}

export class AnularDto {
  @IsString()
  @MinLength(10, { message: 'Contá el motivo con un poco más de detalle (al menos 10 caracteres).' })
  @MaxLength(255)
  motivo: string;

  // El importe del movimiento, escrito a mano: confirma que se sabe cuánta plata se anula.
  @IsInt({ message: 'Escribí el importe para confirmar.' })
  @Min(1, { message: 'Escribí el importe para confirmar.' })
  confirmacion: number;
}

export class AnulacionesQueryDto {
  @IsOptional()
  @Matches(MES, { message: 'El mes tiene que tener el formato AAAA-MM.' })
  mes?: string;
}

export class AbonosQueryDto {
  @Matches(MES, { message: 'El mes tiene que tener el formato AAAA-MM.' })
  mes: string;
}

export class CargarAbonosDto {
  @Matches(MES, { message: 'El mes tiene que tener el formato AAAA-MM.' })
  mes: string;

  // Hasta el 28: todos los meses lo tienen.
  @IsInt({ message: 'Elegí el día de vencimiento.' })
  @Min(1)
  @Max(28, { message: 'El vencimiento va del día 1 al 28.' })
  vencimientoDia: number;
}

export class DevolucionDto {
  @IsInt(ENTEROS)
  @Min(1)
  @Max(MAXIMO)
  importe: number;

  // Efectivo o transferencia: el cheque ya no se recibe y MercadoPago se acredita solo.
  @IsIn(CUENTA_METODO_MANUAL, { message: 'El medio tiene que ser efectivo o transferencia.' })
  metodo: CuentaMetodoManual;

  @IsString()
  @MinLength(10, { message: 'Contá el motivo con un poco más de detalle (al menos 10 caracteres).' })
  @MaxLength(255)
  motivo: string;

  @IsOptional()
  @IsUUID('all')
  solicitudId?: string;
}
