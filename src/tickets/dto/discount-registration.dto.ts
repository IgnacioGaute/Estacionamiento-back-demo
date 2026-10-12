import { IsInt, IsString, MaxLength, Min } from 'class-validator';

export class DiscountRegistrationDto {
  @IsInt() @Min(1) monto: number;
  @IsString() @MaxLength(255) motivo: string;
  @IsInt() @Min(0) expectedPrice: number;
  @IsInt() @Min(0) expectedCollected: number;
}
