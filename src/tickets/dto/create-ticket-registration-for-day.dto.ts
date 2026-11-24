import { IsBoolean, IsEnum, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, Min } from "class-validator";
import { TICKET_TIME_TYPE, TicketTimeType } from "../entities/ticket-price.entity";
import { TicketType } from "../entities/ticket.entity";

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

    // Cobrada en efectivo al registrarla: lo que entregó el cliente (ver efectivo-recibido.ts).
    @IsOptional()
    @IsInt({ message: 'Lo que entrega el cliente va en pesos enteros.' })
    @Min(0)
    @Max(1_000_000_000)
    efectivoRecibido?: number;

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

  // Se cobra ahora en efectivo: lo que entregó el cliente (ver efectivo-recibido.ts).
  @IsOptional()
  @IsInt({ message: 'Lo que entrega el cliente va en pesos enteros.' })
  @Min(0)
  @Max(1_000_000_000)
  efectivoRecibido?: number;
}
