import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const recortar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Crear la caja con la ubicación del dispositivo: el resto lo resuelve el servidor.
export class CrearCajaConUbicacionDto {
  @IsUUID()
  playaId: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  latitud: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitud: number;
}

// La caja de MercadoPago de una playa, a mano (si la ubicación no alcanzó). MercadoPago exige la
// dirección completa de la sucursal, con coordenadas.
export class CrearCajaQrDto {
  @IsUUID()
  playaId: string;

  @Transform(recortar)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  calle: string;

  @Transform(recortar)
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  numero: string;

  @Transform(recortar)
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  ciudad: string;

  @Transform(recortar)
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  provincia: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  latitud: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitud: number;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(80)
  referencia?: string;
}
