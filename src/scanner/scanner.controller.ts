import { Controller, Post, Body, UseGuards, Req, UnauthorizedException } from '@nestjs/common';
import { AuthenticatedRequest } from 'src/types/request';
import { ScannerService } from '../scanner/scanner.service';
import { ScannerDto } from './dto/scanner.dto';

import { AuthOrTokenAuthGuard } from 'src/utils/guards/auth-or-token.guard';

@Controller('scanner')
@UseGuards(AuthOrTokenAuthGuard)
export class ScannerController {
  constructor(private readonly scannerService: ScannerService) {}

  @Post('start-scanner')
  async startScanner(@Req() req: AuthenticatedRequest, @Body() scannerDto: ScannerDto) {
    if (!req.user?.userId) throw new UnauthorizedException('Esta acción requiere un usuario autenticado.');
    return await this.scannerService.start(scannerDto, req.user.userId);
  }
}
