import { PartialType } from '@nestjs/mapped-types';
import { Allow, IsOptional, IsString } from 'class-validator';
import { CreateParkingRenterDto } from './create-parking-renter.dto';

export class UpdateParkingRenterDto extends PartialType(CreateParkingRenterDto) {
  // Presencia de `id` distingue "renter existente" de "renter nuevo" en update().
  @IsString()
  @IsOptional()
  id?: string;

  // TODO: no se lee en ningún lado del server hoy (heredado de update-customer.dto.ts).
  // Se mantiene declarado porque ValidationPipe usa forbidNonWhitelisted: true — si el
  // frontend lo sigue mandando y el DTO no lo declara, esas requests fallan con 400.
  // Confirmar con el frontend antes de eliminarlo.
  @Allow()
  @IsOptional()
  newOwner?: string;
}
