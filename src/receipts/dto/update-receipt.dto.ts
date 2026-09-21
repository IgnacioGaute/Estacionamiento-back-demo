import { ArrayMinSize, IsArray, ArrayMaxSize, Min, IsBoolean, IsEnum, IsNumber, IsOptional, IsString, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { PAYMENT_TYPE, PaymentType } from "../entities/receipt-payment.entity";


export class UpdateReceiptDto {

    @ValidateNested({ each: true })
    @Type(() => ReceiptPaymentDto)
    @ArrayMinSize(1) // Requiere al menos un método de pago
    @IsArray()
    @ArrayMaxSize(10)
    payments: ReceiptPaymentDto[];

    @IsBoolean()
    @IsOptional()
    print: boolean;

    @IsString()
    @IsOptional()
    barcode: string;

    @IsBoolean()
    @IsOptional()
    onAccount: boolean
}

export class ReceiptPaymentDto {
    @IsEnum(PAYMENT_TYPE)
    paymentType: PaymentType;

    @IsNumber()
    @Min(0)
    @IsOptional()
    price: number;
}
