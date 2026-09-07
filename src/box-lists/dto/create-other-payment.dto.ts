import { IsArray, IsDate, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Matches } from "class-validator"
import { PAYMENT_METHOD, PAYMENT_TYPE, PaymentMethod, PaymentType } from "../entities/other-payment.entity";

export class CreateOtherPaymentDto {

    @IsString()
    @IsOptional()
    description: string;

    @IsEnum(PAYMENT_TYPE)
    @IsOptional()
    type: PaymentType;

    @IsEnum(PAYMENT_METHOD)
    @IsOptional()
    paymentMethod: PaymentMethod;

    @IsNumber()
    @IsNotEmpty()
    price: number
}
