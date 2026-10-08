import { IsNumber, Max, Min } from 'class-validator';

export class ComisionesCajaDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  qrPorcentaje: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  transferenciaPorcentaje: number;
}
