import { ArrayUnique, IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';
import { ROL_PLAYA, RolPlaya } from '../entities/usuario-playa.entity';

export class AsignarPlayasDto {
  // La lista completa de playas a las que entra el usuario: lo que no venga se le revoca.
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  playaIds: string[];

  @IsIn(ROL_PLAYA)
  @IsOptional()
  rolPlaya?: RolPlaya;
}
