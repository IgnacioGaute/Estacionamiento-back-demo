import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { ScannerService } from '../scanner/scanner.service';
import { ScannerDto } from './dto/scanner.dto';
import { UpdateReceiptDto } from 'src/receipts/dto/update-receipt.dto';

import { AuthOrTokenAuthGuard } from 'src/utils/guards/auth-or-token.guard';

@Controller('scanner')
@UseGuards(AuthOrTokenAuthGuard)
export class ScannerController {
  constructor(private readonly scannerService: ScannerService) {}

  @Post('start-scanner')
  async startScanner(@Body() scannerDto: ScannerDto) {
    return await this.scannerService.start(scannerDto);
  }
}
