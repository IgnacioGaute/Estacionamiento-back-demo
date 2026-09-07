import { IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CUSTOMER_TYPE, CustomerType } from '../entities/customer.entity';
import { UpdateParkingOwnerDto } from 'src/parking/dto/update-parking-owner.dto';
import { UpdateParkingRenterDto } from 'src/parking/dto/update-parking-renter.dto';

export class UpdateCustomerDto {
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
  @Type(() => UpdateParkingOwnerDto)
  @IsOptional()
  parkingOwners?: UpdateParkingOwnerDto[];

  @IsArray()
  @ValidateNested({ each: true }) // Validar cada inquilino individualmente
  @Type(() => UpdateParkingRenterDto)
  @IsOptional()
  parkingRenters?: UpdateParkingRenterDto[];
}

class MonthDebtDto {
  @IsString()
  month: string; // Formato esperado: 'YYYY-MM'

  @IsNumber()
  amount: number; // Monto de la deuda para ese mes
}
