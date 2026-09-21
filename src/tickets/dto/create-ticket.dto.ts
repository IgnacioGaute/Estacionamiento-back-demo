import { Matches } from 'class-validator';
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from "class-validator";
import { TICKET_DAY_TYPE, TICKET_TYPE, TicketDayType, TicketType } from "../entities/ticket.entity";

export class CreateTicketDto {

    @IsString()
    @IsNotEmpty()
    codeBar: string

    @Matches(/^[A-Z][A-Z0-9_]{0,31}$/)
    vehicleType: TicketType;

    @IsEnum(TICKET_DAY_TYPE)
    @IsOptional()
    ticketDayType: TicketDayType;
}
