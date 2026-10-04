import { IsBoolean, IsEnum, IsOptional, IsString } from "class-validator";
import { PAYMENT_TYPE, PaymentType } from "src/receipts/entities/receipt.entity";

export class ScannerDto {

    @IsEnum(PAYMENT_TYPE)
    @IsOptional()
    paymentType: PaymentType

    @IsBoolean()
    @IsOptional()
    print: boolean;

    @IsString()
    @IsOptional()
    barCode: string;
}


