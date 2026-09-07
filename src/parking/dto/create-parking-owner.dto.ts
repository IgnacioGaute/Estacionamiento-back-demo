import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateParkingOwnerDto {
  @IsString()
  @IsOptional()
  licensePlate: string;

  @IsString()
  @IsOptional()
  garageNumber: string;

  @IsBoolean()
  @IsOptional()
  rent: boolean;

  @IsString()
  @IsOptional()
  ownerParkingTypeId: string;

  @IsNumber()
  @IsOptional()
  amount: number;

  @IsNumber()
  @IsOptional()
  amountRenter: number;
}
