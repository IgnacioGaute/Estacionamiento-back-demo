import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { CobrosMercadoPagoService } from './cobros.service';
import { CrearCobroDto } from './dto/crear-cobro.dto';
import { AuthOrTokenAuthGuard } from 'src/utils/guards/auth-or-token.guard';

// El cobro con QR desde el mostrador. A diferencia de conectar la cuenta —que es del
// administrador— esto lo usa el cajero, así que sus tres handlers están en OPERATOR_ENDPOINTS.
//
// Se exige un usuario real: el pago termina en un movimiento del libro, y el libro no admite
// plata sin responsable.
@UseGuards(AuthOrTokenAuthGuard)
@Controller('mercadopago/cobros')
export class CobrosMercadoPagoController {
  constructor(private readonly cobros: CobrosMercadoPagoService) {}

  private usuario(req: any): string {
    if (!req.user?.userId)
      throw new UnauthorizedException(
        'Esta acción requiere un usuario autenticado.',
      );
    return req.user.userId;
  }

  @Post()
  crearCobro(@Body() dto: CrearCobroDto, @Req() req: any) {
    return this.cobros.crear(dto.registrationId, dto.tipo ?? 'HORA', this.usuario(req));
  }

  @Get(':id')
  consultarCobro(@Param('id', ParseUUIDPipe) id: string) {
    return this.cobros.consultar(id);
  }

  @Delete(':id')
  cancelarCobro(@Param('id', ParseUUIDPipe) id: string) {
    return this.cobros.cancelar(id);
  }
}
