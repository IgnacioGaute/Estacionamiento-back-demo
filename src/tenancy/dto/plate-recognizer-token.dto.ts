import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

// El «API Token» de la cuenta de Plate Recognizer del cliente. Suele pegarse con el prefijo que
// muestra su documentación («Token abc…»): se lo saca acá en vez de rechazarlo.
export class PlateRecognizerTokenDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().replace(/^Token\s+/i, '') : value,
  )
  @IsString()
  @Matches(/^[A-Za-z0-9]{20,128}$/, {
    message: 'Pegá solo el API Token de Plate Recognizer: letras y números, sin espacios.',
  })
  token: string;
}
