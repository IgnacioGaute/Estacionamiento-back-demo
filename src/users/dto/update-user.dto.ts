import { PartialType } from '@nestjs/mapped-types';
import { IsOptional, IsUUID } from 'class-validator';
import { CreateUserDto } from './create-user.dto';

export class UpdateUserDto extends PartialType(CreateUserDto) {
  // Solo al pasar un administrador a operador: la playa donde va a operar. Si falta y no hay
  // una sola opción posible, el cambio se rechaza con PLAYA_REQUERIDA.
  @IsOptional()
  @IsUUID()
  playaId?: string;
}
