import { Controller, Get, Header, Param } from '@nestjs/common';
import { ParkingReceiptsService } from './parking-receipts.service';

@Controller('public/parking-receipts')
export class PublicParkingReceiptsController {
  constructor(private readonly receipts: ParkingReceiptsService) {}

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  read(@Param('token') token: string) {
    return this.receipts.readPublic(token);
  }
}
