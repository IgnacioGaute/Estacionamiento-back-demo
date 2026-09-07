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

    @IsEnum(VEHICLE_TYPE)
    @IsOptional()
    vehicleType: VehicleType;

    @IsEnum(TICKET_TIME_TYPE)
    @IsOptional()
    ticketTimeType: TicketTimeType;

    @IsNumber()
    @IsOptional()
    intervalMinutes: number;
}
