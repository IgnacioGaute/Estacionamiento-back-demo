import { ArrayMaxSize, ArrayUnique, IsArray, IsUUID, ValidateIf, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PricingOptionsDto } from './pricing-options.dto';
import { ReceiptDeliveryDto } from './receipt-delivery.dto';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, Max, Min } from 'class-validator';

export class SueldoUsuarioDto {
  @IsUUID() usuarioId: string;
  @IsInt() @Min(1) @Max(100000000) importe: number;
}

export class UpdateTicketScheduleDto {
  @ValidateIf((_o, value) => value !== undefined) @IsArray() @ArrayMaxSize(1000) @ArrayUnique((s: SueldoUsuarioDto) => s?.usuarioId)
  @ValidateNested({ each: true }) @Type(() => SueldoUsuarioDto)
  sueldosPorUsuario?: SueldoUsuarioDto[];
  @IsOptional() @IsBoolean() sueldoAutomatico?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100000000) sueldoPorTurno?: number;
  @IsOptional() @ValidateNested() @Type(() => ReceiptDeliveryDto)
  receiptDelivery?: ReceiptDeliveryDto;
  @IsOptional() @ValidateNested() @Type(() => PricingOptionsDto)
  pricingOptions?: PricingOptionsDto;
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  @IsNotEmpty()
  dayStartHour?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  @IsNotEmpty()
  dayEndHour?: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  graceMinutes?: number;

  @IsBoolean()
  @IsOptional()
  barcodeTicketsEnabled?: boolean;

  @IsBoolean()
  @IsOptional()
  shiftsEnabled?: boolean;

  @IsBoolean() @IsOptional() multipleShiftsEnabled?: boolean;

  @IsIn(['ENTRY', 'EXIT'])
  @IsOptional()
  pricingDayTypeBasis?: 'ENTRY' | 'EXIT';
}
