import { IsNotEmpty, IsNumber, IsString } from "class-validator";

export class CreateRenterParkingTypeDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsNumber()
  @IsNotEmpty()
  amount: number;
}
