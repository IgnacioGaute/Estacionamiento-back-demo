import { IsBoolean, IsEnum, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Matches } from "class-validator";
import { TICKET_TIME_TYPE, TicketTimeType } from "../entities/ticket-price.entity";
import { TICKET_TYPE, TicketType } from "../entities/ticket.entity";

export class CreateTicketRegistrationForDayDto {

    @IsNumber()
    @IsOptional()
    weeks: number;

    @IsNumber()
    @IsOptional()
    days: number;

    @IsNumber()
    @IsOptional()
    months: number;

    @IsEnum(TICKET_TIME_TYPE)
    ticketTimeType: TicketTimeType;

    @Matches(/^[A-Z][A-Z0-9_]{0,31}$/)
    vehicleType: TicketType;

    @IsString()
    @IsOptional()
    firstNameCustomer: string;

    @IsString()
    @IsOptional()
    lastNameCustomer: string;

    @IsString()
    @IsNotEmpty()
    vehiclePlateCustomer: string;

    @IsBoolean()
    @IsOptional()
    paid: boolean;

    @IsBoolean()
    @IsOptional()
    retired: boolean;

    @IsIn(['CASH', 'TRANSFER'])
    @IsOptional()
    paymentMetodo?: 'CASH' | 'TRANSFER';

}


export class UpdateTicketStatusDto {
  @IsOptional()
  @IsBoolean()
  paid?: boolean;

  @IsOptional()
  @IsBoolean()
  retired?: boolean;

  @IsOptional()
  @IsIn(['CASH', 'TRANSFER'])
  paymentMetodo?: 'CASH' | 'TRANSFER';
}
