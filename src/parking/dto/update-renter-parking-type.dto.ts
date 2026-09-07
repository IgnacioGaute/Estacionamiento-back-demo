import { PartialType } from '@nestjs/mapped-types';
import { IsNotEmpty, IsString, Matches } from "class-validator";
import { CreateRenterParkingTypeDto } from './create-renter-parking-type.dto';

export class UpdateRenterParkingTypeDto extends PartialType(CreateRenterParkingTypeDto) {
  // Ej: "2026-02" — mes objetivo para el cascade de recibos pendientes al cambiar el precio.
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: "month debe ser YYYY-MM (ej: 2026-02)" })
  month: string;
}
