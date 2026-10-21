import { IsIn } from 'class-validator';
import { Modalidad, MODALIDADES } from '../modalidad';

// La modalidad de operación de una playa (ver src/tenancy/modalidad.ts). Solo el super admin.
export class CambiarModalidadDto {
  @IsIn(MODALIDADES)
  modalidad: Modalidad;
}
