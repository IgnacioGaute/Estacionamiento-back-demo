import { IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CUSTOMER_TYPE, CustomerType } from '../entities/customer.entity';
import { PAYMENT_TYPE, PaymentType } from 'src/receipts/entities/receipt-payment.entity';
import { CreateParkingOwnerDto } from 'src/parking/dto/create-parking-owner.dto';
import { CreateParkingRenterDto } from 'src/parking/dto/create-parking-renter.dto';

export class CreateCustomerDto {
  @IsString()
  firstName: string;

  @IsString()
  lastName: string;

  @IsString()
  phone: string;

  @IsString()
  @IsOptional()
  comments: string;

  @IsNumber()
  @IsOptional()
  customerNumber: number;

  @IsNumber()
  numberOfVehicles: number;

  @IsEnum(CUSTOMER_TYPE)
  customerType: CustomerType;

  @IsBoolean()
  @IsOptional()
  hasDebt: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MonthDebtDto)
  monthsDebt?: MonthDebtDto[];

  @IsNumber()
  credit: number;

  @IsArray()
  @ValidateNested({ each: true }) // Validar cada owner individualmente
  @Type(() => CreateParkingOwnerDto)
  @IsOptional()
  parkingOwners?: CreateParkingOwnerDto[]; // Hacer que los owners sean opcionales

  @IsArray()
  @ValidateNested({ each: true }) // Validar cada inquilino individualmente
  @Type(() => CreateParkingRenterDto)
  @IsOptional()
  parkingRenters?: CreateParkingRenterDto[]; // Hacer que los inquilinos sean opcionales
}

class MonthDebtDto {
  @IsString()
  month: string; // Formato esperado: 'YYYY-MM'

  @IsNumber()
  @IsOptional()
  amount?: number; // Monto de la deuda para ese mes

  @IsEnum(PAYMENT_TYPE)
  @IsOptional()
  paymentType: PaymentType;
}
