import { IsNotEmpty, IsNumber, IsString } from "class-validator";

export class CreateOwnerParkingTypeDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsNumber()
  @IsNotEmpty()
  amount: number;
}
