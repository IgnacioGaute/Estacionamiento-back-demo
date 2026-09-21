import { Matches } from 'class-validator';
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from "class-validator";
import { TICKET_TIME_TYPE, TicketTimeType, VEHICLE_TYPE, VehicleType } from "../entities/ticket-price.entity";
import { TICKET_DAY_TYPE, TicketDayType } from "../entities/ticket.entity";

export class CreateTicketPriceDto {

    @IsNumber()
    @IsOptional()
    price: number

    @IsNumber()
    @IsOptional()
    ticketTimePrice: number;

   @IsEnum(TICKET_DAY_TYPE)
    @IsOptional()
    ticketDayType: TicketDayType;

    @Matches(/^[A-Z][A-Z0-9_]{0,31}$/)
    @IsOptional()
    vehicleType: VehicleType;

    @IsEnum(TICKET_TIME_TYPE)
    @IsOptional()
    ticketTimeType: TicketTimeType;

    @IsNumber()
    @IsOptional()
    intervalMinutes: number;
}
