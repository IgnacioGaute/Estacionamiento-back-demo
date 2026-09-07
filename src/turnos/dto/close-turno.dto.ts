import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

export class CloseTurnoDto {
  @IsInt()
  @Min(0)
  @IsNotEmpty()
  efectivoContado: number;

  @IsString()
  @IsOptional()
  observaciones?: string;
}
