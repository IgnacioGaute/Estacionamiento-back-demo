import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { MOVIMIENTO_METODO, MovimientoMetodo } from 'src/movimientos/entities/movimiento.entity';

export class AdvancePaymentTicketRegistrationDto {
  // Monto efectivamente cobrado ahora. Opcional: se puede declarar la duración esperada
  // sin cobrar nada todavía (el cliente paga recién al salir).
  @IsInt()
  @Min(0)
  @IsOptional()
  advancePaidAmount?: number;

  // Obligatorio cuando advancePaidAmount sube respecto del valor anterior (verificado en el
  // servicio) — cómo se cobró el anticipo.
  @IsEnum(MOVIMIENTO_METODO)
  @IsOptional()
  metodo?: MovimientoMetodo;

  @IsString()
  @IsOptional()
  adjustmentReason?: string;

  // Duración que el operador avisó que el cliente iba a quedarse (nombre de la franja
  // elegida en el form) y su tope en minutos, para poder avisar si la estadía real la supera.
  @IsString()
  @IsOptional()
  expectedBracketLabel?: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  expectedUptoMinutes?: number;

  @IsString()
  @IsOptional()
  firstNameCustomer?: string;

  @IsString()
  @IsOptional()
  lastNameCustomer?: string;

  @IsString()
  @IsOptional()
  vehiclePlateCustomer?: string;
}
