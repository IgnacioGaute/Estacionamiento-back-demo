import { Allow, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class CreateParkingRenterDto {
  @IsString()
  @IsOptional()
  licensePlate: string;

  @IsString()
  @IsOptional()
  garageNumber: string;

  // Particulares: id del ParkingOwner cuya cochera alquila. Inquilinos: no se manda (la cochera
  // va con su número y su precio); los inquilinos viejos pueden traer el nombre de un
  // RenterParkingType.
  @Allow()
  @IsOptional()
  owner?: string;

  // Precio mensual de la cochera. Obligatorio en la cochera de un inquilino sin `owner`; con un
  // tipo de dueño el precio sale del tipo, y con un propietario real, de su `amountRenter`.
  @IsInt({ message: 'El precio de la cochera va en pesos enteros.' })
  @Min(0, { message: 'El precio de la cochera no puede ser negativo.' })
  @Max(100_000_000, { message: 'El precio de la cochera es demasiado alto.' })
  @IsOptional()
  amount: number;
}
