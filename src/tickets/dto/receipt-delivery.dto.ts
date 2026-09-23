import { IsBoolean, IsIn } from 'class-validator';

export class ReceiptDeliveryDto {
  @IsBoolean() whatsapp: boolean;
  @IsBoolean() qr: boolean;
  @IsBoolean() print: boolean;
  @IsIn([58, 80]) paperWidth: 58 | 80;
}

export class IssueParkingReceiptDto {
  @IsIn(['ENTRY', 'EXIT']) kind: 'ENTRY' | 'EXIT';
}
