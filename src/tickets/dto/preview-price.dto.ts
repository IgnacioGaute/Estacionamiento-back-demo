import { ValidateNested } from 'class-validator';
import { PricingOptionsDto } from './pricing-options.dto';
import { IsISO8601, IsOptional, Max } from 'class-validator';
import { Matches } from 'class-validator';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, Min } from 'class-validator';
import { TICKET_TYPE, TICKET_DAY_TYPE, TicketType, TicketDayType } from '../entities/ticket.entity';

export class PreviewPriceDto {
  @IsOptional() @IsISO8601() entryAt?: string;
  @Matches(/^[A-Z][A-Z0-9_]{0,31}$/)
  vehicleType: TicketType;

  @IsOptional()
  @IsEnum(TICKET_DAY_TYPE)
  ticketDayType: TicketDayType;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5256000)
  elapsedMinutes: number;
}

export class SimulatePriceDto extends PreviewPriceDto {
  @IsOptional() @ValidateNested() @Type(() => PricingOptionsDto) pricingOptions?: PricingOptionsDto;
}
