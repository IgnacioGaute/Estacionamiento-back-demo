import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsUUID('4') token: string;
  @IsString() @MinLength(8) @MaxLength(72) password: string;
}
