import {
    IsEnum,
    IsNotEmpty,
    IsOptional,
    IsString, IsEmail, MinLength, MaxLength
  } from 'class-validator';
  import { USER_ROLES, UserRole } from 'src/users/entities/user.entity';

  export class CreateUserDto {
    @IsString()
    @IsNotEmpty()
    @IsEmail()
    email: string;

    @IsString()
    @IsNotEmpty()
    firstName: string;

    @IsString()
    @IsNotEmpty()
    lastName: string;

    @IsString()
    @IsOptional()
    @MinLength(8)
    @MaxLength(72)
    password: string;

    @IsString()
    @IsNotEmpty()
    username: string;

    @IsEnum(['USER', 'ADMIN'])
    role: UserRole;
  }

