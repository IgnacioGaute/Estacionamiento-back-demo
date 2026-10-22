import { IsUUID, IsIn, IsISO8601, IsString, IsOptional, MaxLength, IsInt, Min, Max, IsBoolean, IsObject } from 'class-validator';
export const OFFLINE_ACTIONS = ['PLATE_ENTRY', 'CARD_ENTRY', 'CLOSE', 'ADVANCE', 'DISCOUNT', 'PARTIAL_CASH', 'EDIT', 'EDIT_ENTRY', 'DELETE', 'PASS_ENTRY', 'PASS_UPDATE', 'SHIFT_OPEN', 'SHIFT_CLOSE', 'CASH_MOVEMENT', 'BOX_MOVEMENT'] as const;
export class OfflineDeviceDto {
  @IsUUID() deviceId: string;
  @IsOptional() @IsBoolean() refresh?: boolean;
  @IsOptional() @IsUUID() knownSessionId?: string;
}
export class OfflineOperationDto extends OfflineDeviceDto {
  @IsUUID() sessionId: string;
  @IsUUID() id: string;
  @IsUUID() registrationId: string;
  @IsIn(['ENTRY', 'EXIT', 'ACTION']) kind: 'ENTRY' | 'EXIT' | 'ACTION';
  @IsOptional() @IsIn(OFFLINE_ACTIONS) action?: typeof OFFLINE_ACTIONS[number];
  @IsOptional() @IsObject() data?: Record<string, any>;
  @IsOptional() @IsString() @MaxLength(2000) expectedState?: string;
  @IsOptional() @IsUUID() shiftId?: string | null;
  @IsOptional() @IsUUID() cashSessionId?: string;
  @IsISO8601() occurredAt: string;
  @IsOptional() @IsString() @MaxLength(20) plate?: string;
  @IsOptional() @IsString() @MaxLength(40) vehicleType?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100000000) expectedPrice?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100000000) expectedCollected?: number;
  @IsOptional() @IsIn(['CASH', 'TRANSFER']) method?: 'CASH' | 'TRANSFER';
}
export class OfflineFinishDto extends OfflineDeviceDto { @IsUUID() sessionId: string; }
