import { IsBoolean, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
export class CreateVehicleTypeDto {
  @Matches(/^[A-Z][A-Z0-9_]{0,31}$/) code: string;
  @IsString() @IsNotEmpty() @MaxLength(80) name: string;
}
export class UpdateVehicleTypeDto {
  @IsString() @IsNotEmpty() @MaxLength(80) @IsOptional() name?: string;
  @IsBoolean() @IsOptional() enabled?: boolean;
}
