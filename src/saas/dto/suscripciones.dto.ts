import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  MEDIO_PAGO_SAAS,
  MedioPagoSaas,
} from '../entities/factura-saas.entity';

const FECHA = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const FECHA_INVALIDA = {
  message: 'La fecha tiene que tener el formato AAAA-MM-DD.',
};
// Pesos enteros, como el resto de la plata del sistema.
const ENTEROS = { message: 'Los importes van en pesos enteros, sin centavos.' };
const MAXIMO = 100_000_000;
const recortar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class AsignarPlanDto {
  @IsUUID('all')
  planId: string;

  // Precio pactado. Sin esto se usa el de lista (con 30% menos si es una playa adicional).
  @IsOptional()
  @IsInt(ENTEROS)
  @Min(0)
  @Max(MAXIMO)
  precio?: number;
}

export class EditarSuscripcionDto {
  // La fecha real de inicio del cliente. Si todavía no pagó, la prueba se corre con ella.
  @IsOptional()
  @Matches(FECHA, FECHA_INVALIDA)
  alta?: string;

  // Para dar de alta a un cliente que ya venía pagando por fuera: hasta qué día tiene pago.
  @IsOptional()
  @Matches(FECHA, FECHA_INVALIDA)
  pagadoHasta?: string;

  @IsOptional()
  @IsBoolean()
  bonificada?: boolean;

  // Cada cuánto paga: el código de un período del catálogo (MENSUAL, TRIMESTRAL, ANUAL).
  @IsOptional()
  @Matches(/^[A-Z_]{3,20}$/, { message: 'Elegí un período de pago.' })
  periodo?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Transform(recortar)
  @IsString()
  @MaxLength(1000)
  notas?: string | null;
}

export class EditarPeriodoDto {
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  nombre?: string;

  // Porcentaje entero. Más de la mitad sería regalar el sistema: si hace falta, bonificar.
  @IsOptional()
  @IsInt({ message: 'El descuento va en porcentaje entero.' })
  @Min(0)
  @Max(50)
  descuento?: number;

  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}

// Dar de alta la cuenta: desde qué día es cliente y cuántos días de prueba gratis tiene antes de
// la primera factura. No hace falta tener plan asignado.
export class ActivarCuentaDto {
  @Matches(FECHA, FECHA_INVALIDA)
  alta: string;

  // 0 = sin prueba: la primera factura vence el mismo día del alta.
  @IsInt()
  @Min(0)
  @Max(60)
  diasPrueba: number;
}

// Más tiempo sin pagar. Para quien nunca pagó alarga la prueba (y corre la primera factura);
// para quien ya paga es una prórroga: corre la suspensión, no el vencimiento.
export class DiasExtraDto {
  // Último día con acceso sin pagar.
  @Matches(FECHA, FECHA_INVALIDA)
  hasta: string;

  @Transform(recortar)
  @IsString()
  @MinLength(3, { message: 'Contá brevemente por qué se dan días extra.' })
  @MaxLength(300)
  motivo: string;
}

export class RegistrarPagoSaasDto {
  @IsInt()
  @Min(1)
  @Max(12)
  meses: number;

  @IsInt(ENTEROS)
  @Min(1)
  @Max(MAXIMO)
  importe: number;

  @IsIn(MEDIO_PAGO_SAAS, { message: 'Elegí cómo pagó.' })
  medio: MedioPagoSaas;

  // El día en que entró la plata. No puede ser futuro.
  @Matches(FECHA, FECHA_INVALIDA)
  fecha: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(255)
  referencia?: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(500)
  nota?: string;
}

export class AnularPagoSaasDto {
  // Anular un pago es raro y corre el vencimiento para atrás: se pide una razón de verdad.
  @Transform(recortar)
  @IsString()
  @MinLength(10, {
    message: 'Explicá en al menos 10 caracteres por qué se anula el pago.',
  })
  @MaxLength(500)
  motivo: string;
}

export class EditarPlanDto {
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nombre?: string;

  @IsOptional()
  @IsInt(ENTEROS)
  @Min(0)
  @Max(MAXIMO)
  precioMensual?: number;

  // null = sin límite.
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(100_000)
  maxActivos?: number | null;

  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}

export class ActivarDebitoDto {
  // Sin tarjeta, el de su cuenta de MercadoPago (la suscripción la confirma esa cuenta). Con
  // tarjeta, el que quiera: MercadoPago le manda ahí los avisos de cada cobro.
  @Transform(recortar)
  @IsEmail({}, { message: 'Ingresá un email válido.' })
  @MaxLength(255)
  email: string;

  // El token que devuelve el formulario de tarjeta de MercadoPago. Nunca llegan datos de tarjeta.
  @IsOptional()
  @Matches(/^[A-Za-z0-9-]{8,100}$/, {
    message: 'La tarjeta no se pudo leer. Cargala de nuevo.',
  })
  tarjeta?: string;
}

export class PagosSaasQueryDto {
  @Matches(FECHA, FECHA_INVALIDA)
  desde: string;

  @Matches(FECHA, FECHA_INVALIDA)
  hasta: string;
}
