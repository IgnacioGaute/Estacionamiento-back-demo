import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { TICKET_DAY_TYPE, TicketDayType, TICKET_TYPE, TicketType } from '../entities/ticket.entity';

export class CreateTicketPriceBracketDto {
  @IsEnum(TICKET_TYPE)
  @IsNotEmpty()
  vehicleType: TicketType;

  @IsEnum(TICKET_DAY_TYPE)
  @IsOptional()
  ticketDayType?: TicketDayType;

  @IsString()
  @IsNotEmpty()
  label: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  uptoMinutes?: number;

  @IsInt()
  @Min(0)
  @IsNotEmpty()
  price: number;

  // Solo tiene sentido cuando uptoMinutes es undefined (última franja, sin límite): hace que
  // `price` se cobre repetidamente cada recurringUnitMinutes en vez de una sola vez.
  @IsInt()
  @Min(1)
  @IsOptional()
  recurringUnitMinutes?: number;
}
