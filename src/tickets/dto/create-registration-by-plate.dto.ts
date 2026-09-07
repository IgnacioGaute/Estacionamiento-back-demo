import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { TICKET_TYPE, TicketType } from '../entities/ticket.entity';

export class CreateRegistrationByPlateDto {
  // Requerida salvo que noPlate sea true (verificado en el servicio, no acá).
  @IsString()
  @IsOptional()
  licensePlate?: string;

  @IsEnum(TICKET_TYPE)
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
