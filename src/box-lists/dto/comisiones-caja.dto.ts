import { IsDefined, IsNumber, Max, Min, ValidateIf } from 'class-validator';
export class ComisionesCajaDto {
  @ValidateIf((_, v) => v !== null) @IsDefined() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(100)
  qrSaldo: number | null;
  @ValidateIf((_, v) => v !== null) @IsDefined() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(100)
  qrDebito: number | null;
  @ValidateIf((_, v) => v !== null) @IsDefined() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(100)
  qrCredito: number | null;
  @ValidateIf((_, v) => v !== null) @IsDefined() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(100)
  aliasSaldo: number | null;
  @ValidateIf((_, v) => v !== null) @IsDefined() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(100)
  aliasDebito: number | null;
  @ValidateIf((_, v) => v !== null) @IsDefined() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(100)
  aliasCredito: number | null;
}
