import { Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { TICKET_TYPE, TicketType } from '../entities/ticket.entity';

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
