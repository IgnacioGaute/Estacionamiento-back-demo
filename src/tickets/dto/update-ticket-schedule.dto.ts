import { ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PricingOptionsDto } from './pricing-options.dto';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, Max, Min } from 'class-validator';

export class UpdateTicketScheduleDto {
  @IsOptional() @ValidateNested() @Type(() => PricingOptionsDto)
  pricingOptions?: PricingOptionsDto;
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  @IsNotEmpty()
  dayStartHour?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  @IsNotEmpty()
  dayEndHour?: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  graceMinutes?: number;

  @IsBoolean()
  @IsOptional()
  barcodeTicketsEnabled?: boolean;

  @IsIn(['ENTRY', 'EXIT'])
  @IsOptional()
  pricingDayTypeBasis?: 'ENTRY' | 'EXIT';
}
