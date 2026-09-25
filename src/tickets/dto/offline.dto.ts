import { IsUUID, IsIn, IsISO8601, IsString, IsOptional, MaxLength, IsInt, Min, Max } from 'class-validator';
export class OfflineDeviceDto { @IsUUID() deviceId: string; }
export class OfflineOperationDto extends OfflineDeviceDto {
  @IsUUID() sessionId: string;
  @IsUUID() id: string;
  @IsUUID() registrationId: string;
  @IsIn(['ENTRY', 'EXIT']) kind: 'ENTRY' | 'EXIT';
  @IsISO8601() occurredAt: string;
  @IsOptional() @IsString() @MaxLength(20) plate?: string;
  @IsOptional() @IsString() @MaxLength(40) vehicleType?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100000000) expectedPrice?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100000000) expectedCollected?: number;
  @IsOptional() @IsIn(['CASH', 'TRANSFER']) method?: 'CASH' | 'TRANSFER';
}
export class OfflineFinishDto extends OfflineDeviceDto { @IsUUID() sessionId: string; }
