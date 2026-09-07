import { Allow, IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateParkingRenterDto {
  @IsString()
  @IsOptional()
  licensePlate: string;

  @IsString()
  @IsOptional()
  garageNumber: string;

  @Allow()
  @IsOptional()
  owner?: string;

  // Ignorado cuando `owner` matchea el nombre de un RenterParkingType (ahí el
  // amount sale del tipo). Se usa solo cuando `owner` es un ParkingOwner.id real
  // y no hay amountRenter configurado en ese owner.
  @IsNumber()
  @IsOptional()
  amount: number;
}
