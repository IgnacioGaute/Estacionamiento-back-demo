import { PartialType } from '@nestjs/mapped-types';
import { IsOptional, IsString } from 'class-validator';
import { CreateParkingOwnerDto } from './create-parking-owner.dto';

export class UpdateParkingOwnerDto extends PartialType(CreateParkingOwnerDto) {
  // Presencia de `id` distingue "owner existente a reemplazar" de "owner nuevo"
  // en el patrón borrar-y-recrear usado por ParkingOwnersService.updateOwnersForCustomer.
  @IsString()
  @IsOptional()
  id?: string;
}
