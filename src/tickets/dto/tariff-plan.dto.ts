import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDefined, IsIn, IsInt, IsISO8601, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { PricingOptionsDto } from './pricing-options.dto';

export class TariffScheduleDto {
  @IsInt() @Min(0) @Max(23) dayStartHour: number;
  @IsInt() @Min(0) @Max(23) dayEndHour: number;
  @IsInt() @Min(0) @Max(5256000) graceMinutes: number;
  @IsIn(['ENTRY', 'EXIT']) pricingDayTypeBasis: 'ENTRY' | 'EXIT';
  @IsDefined() @ValidateNested() @Type(() => PricingOptionsDto) pricingOptions: PricingOptionsDto;
}

export class TariffBracketDto {
  @IsOptional() @IsUUID() id?: string;
  @Matches(/^[A-Z][A-Z0-9_]{0,31}$/) vehicleType: string;
  @IsOptional() @IsIn(['DAY', 'NIGHT']) ticketDayType?: 'DAY' | 'NIGHT' | null;
  @IsString() @IsNotEmpty() @MaxLength(255) label: string;
  @IsOptional() @IsInt() @Min(0) @Max(5256000) uptoMinutes?: number | null;
  @IsInt() @Min(0) @Max(2147483647) price: number;
  @IsOptional() @IsInt() @Min(1) @Max(5256000) recurringUnitMinutes?: number | null;
  @IsOptional() @IsIn(['FIXED', 'DERIVED']) recurringPriceMode?: 'FIXED' | 'DERIVED';
}

export class TariffPlanDto {
  @IsDefined() @ValidateNested() @Type(() => TariffScheduleDto) schedule: TariffScheduleDto;
  @IsArray() @ArrayMaxSize(2000) @ValidateNested({ each: true }) @Type(() => TariffBracketDto) brackets: TariffBracketDto[];
}

export class UpdateTariffPlanDto extends TariffPlanDto {
  @Matches(/^[a-f0-9]{64}$/) expectedRevision: string;
}

export class SimulateTariffPlanDto {
  @Matches(/^[A-Z][A-Z0-9_]{0,31}$/) vehicleType: string;
  @IsISO8601() entryAt: string;
  @IsInt() @Min(0) @Max(5256000) elapsedMinutes: number;
  @IsOptional() @ValidateNested() @Type(() => TariffPlanDto) plan?: TariffPlanDto;
}
