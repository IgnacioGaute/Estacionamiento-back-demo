import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class DiscountRegistrationDto {
  // Sin `total`, lo que se suma al descuento que ya tenga (lo que mandan las operaciones offline
  // encoladas antes). Con `total`, el descuento de la estadía: reemplaza al anterior, y 0 lo quita.
  @IsInt() @Min(0) monto: number;
  @IsOptional() @IsBoolean() total?: boolean;
  @IsString() @MaxLength(255) motivo: string;
  @IsInt() @Min(0) expectedPrice: number;
  @IsInt() @Min(0) expectedCollected: number;
}
