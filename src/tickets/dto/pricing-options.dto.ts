import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDefined, IsIn, IsInt, Matches, Max, Min, ValidateNested } from 'class-validator';
class RateDto {
  @Matches(/^[A-Z][A-Z0-9_]{0,31}$/) vehicleType: string;
  @IsInt() @Min(0) @Max(100000000) dayPrice: number;
  @IsInt() @Min(0) @Max(100000000) nightPrice: number;
}
class CapDto {
  @Matches(/^[A-Z][A-Z0-9_]{0,31}$/) vehicleType: string;
  @IsInt() @Min(0) @Max(100000000) amount: number;
}
class ChargingDto {
  @IsBoolean() enabled: boolean;
  @IsIn(['STARTED', 'COMPLETED', 'PROPORTIONAL']) mode: 'STARTED' | 'COMPLETED' | 'PROPORTIONAL';
  @IsInt() @Min(1) @Max(10080) unitMinutes: number;
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => RateDto) rates: RateDto[];
}
class StayDto {
  @IsBoolean() enabled: boolean;
  @IsInt() @Min(0) @Max(10080) freeMinutes: number;
  @IsInt() @Min(0) @Max(10080) minimumMinutes: number;
  @IsBoolean() capEnabled: boolean;
  @IsIn([720, 1440]) capMinutes: number;
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => CapDto) caps: CapDto[];
}
class CrossingDto {
  @IsBoolean() enabled: boolean;
  @IsIn(['ENTRY', 'EXIT', 'SPLIT']) mode: 'ENTRY' | 'EXIT' | 'SPLIT';
}
export class PricingOptionsDto {
  @IsDefined() @ValidateNested() @Type(() => ChargingDto) charging: ChargingDto;
  @IsDefined() @ValidateNested() @Type(() => StayDto) stay: StayDto;
  @IsDefined() @ValidateNested() @Type(() => CrossingDto) crossing: CrossingDto;
}
