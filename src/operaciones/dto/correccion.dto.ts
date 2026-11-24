import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { TIPOS_CORRECCION, TipoCorreccion } from '../entities/correccion.entity';

// Una corrección concreta, nunca un formulario que cambie cualquier campo: cada tipo trae solo lo
// que necesita y el servidor decide si se aplica ya o queda para revisión (ver CorreccionesService).
export class CorreccionDto {
  // Lo genera la pantalla al abrir el formulario: un doble toque o un reintento no la duplican.
  @IsUUID() solicitudId: string;

  @IsIn(TIPOS_CORRECCION as unknown as string[], { message: 'Elegí qué hay que corregir.' }) tipo: TipoCorreccion;

  // La operación: una estadía por hora o un pase por día, semana o mes.
  @IsOptional() @IsUUID() registrationId?: string;
  @IsOptional() @IsUUID() paseId?: string;

  // Cómo estaba la operación cuando se abrió el formulario (`version` del detalle): si cambió
  // mientras tanto, se pide revisarla de nuevo en vez de corregir sobre datos viejos.
  @IsString() @MaxLength(200) version: string;

  // Motivo rápido elegido y, si hace falta, el detalle.
  @IsString() @MaxLength(40) motivo: string;
  @IsOptional() @IsString() @MaxLength(500) detalle?: string;

  // IDENTIFICACION: la patente correcta.
  @IsOptional() @IsString() @MaxLength(20) patente?: string;

  // MEDIO_PAGO y RECIBIDO_VUELTO: el cobro (movimiento) corregido.
  @IsOptional() @IsUUID() movimientoId?: string;
  // MEDIO_PAGO: el medio correcto y cuánto de ese cobro (en un pago mixto, la parte equivocada).
  @IsOptional() @IsIn(['CASH', 'TRANSFER']) metodo?: 'CASH' | 'TRANSFER';
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000_000) importe?: number;
  // A transferencia: la operación de Mercado Pago que la respalda (ver candidatasParaCorreccion).
  @IsOptional() @IsString() @Matches(/^[0-9A-Za-z_-]{1,64}$/) operacionId?: string;

  // RECIBIDO_VUELTO: lo que de verdad entregó el cliente.
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000_000) efectivoRecibido?: number;

  // VEHICULO: la estadía que de verdad salió (sigue figurando adentro).
  @IsOptional() @IsUUID() destinoRegistrationId?: string;
}

export class ResolverCorreccionDto {
  @IsIn(['APLICAR', 'RECHAZAR']) accion: 'APLICAR' | 'RECHAZAR';
  @IsString() @MaxLength(500) resolucion: string;
  // La operación como la vio quien revisa: si cambió, se vuelve a mirar.
  @IsOptional() @IsString() @MaxLength(200) version?: string;
  // Al aplicar un cambio a transferencia: la acreditación que la respalda, si se encontró.
  @IsOptional() @IsString() @Matches(/^[0-9A-Za-z_-]{1,64}$/) operacionId?: string;
}

export const TIPOS_HISTORIAL = ['ENTRADA', 'SALIDA', 'ANTICIPO', 'COBRO_PARCIAL', 'DEVOLUCION', 'PASE', 'CORRECCION'] as const;
export type TipoHistorial = (typeof TIPOS_HISTORIAL)[number];
