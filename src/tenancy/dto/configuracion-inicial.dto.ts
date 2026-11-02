import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { PASOS_CONFIGURACION, type PasoConfiguracion } from '../configuracion-inicial';

const recortar = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// El nombre y la dirección que el administrador confirma en los dos primeros pasos.
export class GuardarPlayaConfiguracionDto {
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @IsNotEmpty({ message: 'Escribí el nombre de la playa.' })
  @MaxLength(255)
  nombre?: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @IsNotEmpty({ message: 'Escribí la dirección de la playa.' })
  @MaxLength(255)
  direccion?: string;
}

export class AvanzarConfiguracionDto {
  @IsOptional()
  @IsIn(PASOS_CONFIGURACION)
  paso?: PasoConfiguracion;

  @IsOptional()
  @IsIn(PASOS_CONFIGURACION)
  hecho?: PasoConfiguracion;

  @IsOptional()
  @IsIn(PASOS_CONFIGURACION)
  omitido?: PasoConfiguracion;

  @IsOptional()
  @IsBoolean()
  terminar?: boolean;
}
