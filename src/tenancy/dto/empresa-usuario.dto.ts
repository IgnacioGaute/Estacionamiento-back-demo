import { PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateEmpresaUsuarioDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  firstName: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  lastName: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  username: string;
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(255)
  email: string;
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;
  @IsIn(['ADMIN', 'USER'])
  role: 'ADMIN' | 'USER';
}
export class UpdateEmpresaUsuarioDto extends PartialType(
  CreateEmpresaUsuarioDto,
) {}
