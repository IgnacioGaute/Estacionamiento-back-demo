import { IsISO8601 } from 'class-validator';
import { CloseRegistrationDto } from './close-registration.dto';

// «Se fue antes»: el auto se fue a esta hora y nadie registró la salida. Es un cierre como
// cualquier otro (mismo importe esperado, mismos medios), con la hora en que de verdad se fue.
export class SalidaAnteriorDto extends CloseRegistrationDto {
  @IsISO8601({ strict: true }, { message: 'Indicá a qué hora se fue.' })
  salidaEn: string;
}
