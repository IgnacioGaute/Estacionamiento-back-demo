import { Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { TicketType } from '../entities/ticket.entity';

export class CreateRegistrationByPlateDto {
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().replace(/[\s()+-]/g, '') || undefined : value)
  @Matches(/^[1-9]\d{7,14}$/, { message: 'Ingresá el teléfono con código de país, entre 8 y 15 dígitos.' })
  phoneCustomer?: string;

  // Requerida salvo que noPlate sea true (verificado en el servicio, no acá).
  @IsString()
  @IsOptional()
  licensePlate?: string;

  @Matches(/^[A-Z][A-Z0-9_]{0,31}$/)
  @IsNotEmpty()
  vehicleType: TicketType;

  @IsString()
  @IsOptional()
  casilleroNumber?: string;

  // Obligatorio cuando noPlate es true (verificado en el servicio).
  @IsString()
  @IsOptional()
  lastNameCustomer?: string;

  // DNI, opcional: se guardan solo los dígitos (se aceptan puntos y espacios al escribirlo).
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.replace(/[\s.-]/g, '') || undefined : value)
  @Matches(/^\d{6,9}$/, { message: 'Ingresá el DNI con 6 a 9 números.' })
  documentoCustomer?: string;

  // Modelo del vehículo, opcional (el mostrador sugiere los comunes; se puede escribir cualquiera).
  @IsOptional()
  @IsString()
  @MaxLength(60, { message: 'El modelo puede tener hasta 60 caracteres.' })
  modeloVehiculo?: string;

  @IsBoolean()
  @IsOptional()
  noPlate?: boolean;

  @IsBoolean()
  @IsOptional()
  duplicateOverride?: boolean;

  @IsString()
  @IsOptional()
  duplicateOverrideReason?: string;
}
