import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { CUSTOMER_TYPE, CustomerType } from 'src/customers/entities/customer.entity';

export class UpdateAmountAllCustomerDto {
  @IsNumber()
  @IsNotEmpty()
  amount: number;

  @IsEnum(CUSTOMER_TYPE)
  customerType: CustomerType;

  @IsString()
  @IsOptional()
  ownerTypeOfRenter: string
}
