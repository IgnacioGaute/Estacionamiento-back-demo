import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { MercadoPagoService } from './mercadopago.service';
import { ConectarMercadoPagoDto } from './dto/conectar-mercadopago.dto';
import { AuthOrTokenAuthGuard } from 'src/utils/guards/auth-or-token.guard';

// Conectar y desconectar la cuenta de MercadoPago de la empresa.
//
// Ninguno de estos handlers figura en OPERATOR_ENDPOINTS, así que quedan sólo para administradores:
// un operador de mostrador no tiene por qué poder cambiar a qué cuenta va la plata.
//
// Se exige además un usuario real (no el token estático de servidor), porque quién conectó la
// cuenta queda registrado y porque el `state` de OAuth se valida contra ese mismo usuario.
@UseGuards(AuthOrTokenAuthGuard)
@Controller('mercadopago')
export class MercadoPagoController {
  constructor(private readonly mercadoPago: MercadoPagoService) {}

  private usuario(req: any): string {
    if (!req.user?.userId)
      throw new UnauthorizedException(
        'Esta acción requiere un usuario autenticado.',
      );
    return req.user.userId;
  }

  @Get('estado')
  estado() {
    return this.mercadoPago.estado();
  }

  @Post('conectar')
  conectar(@Req() req: any) {
    return this.mercadoPago.iniciarConexion(this.usuario(req));
  }

  @Post('callback')
  callback(@Body() dto: ConectarMercadoPagoDto, @Req() req: any) {
    return this.mercadoPago.conectar(dto.code, dto.state, this.usuario(req));
  }

  @Delete('desconectar')
  desconectar(@Req() req: any) {
    this.usuario(req);
    return this.mercadoPago.desconectar();
  }
}
