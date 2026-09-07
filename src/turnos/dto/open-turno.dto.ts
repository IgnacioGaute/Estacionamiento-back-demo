import { IsInt, IsNotEmpty, Min } from 'class-validator';

export class OpenTurnoDto {
  @IsInt()
  @Min(0)
  @IsNotEmpty()
  fondoInicial: number;
}
