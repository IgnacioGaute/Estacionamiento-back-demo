import { IsBoolean, IsInt, IsNotEmpty, IsOptional, Max, Min } from 'class-validator';

export class UpdateTicketScheduleDto {
  @IsInt()
  @Min(0)
  @Max(23)
  @IsNotEmpty()
  dayStartHour: number;

  @IsInt()
  @Min(0)
  @Max(23)
  @IsNotEmpty()
  dayEndHour: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  graceMinutes?: number;

  @IsBoolean()
  @IsOptional()
  barcodeTicketsEnabled?: boolean;
}
