import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { MercadoPagoService } from './mercadopago.service';
import { VerificacionAliasService } from './verificacion-alias.service';
import { ConectarMercadoPagoDto } from './dto/conectar-mercadopago.dto';
import { AceptarCondicionesDto } from './dto/condiciones.dto';
import { ConfigurarVerificacionAliasDto } from './dto/verificacion-alias.dto';
import { CajasQrService } from './cajas-qr.service';
import { CrearCajaQrDto } from './dto/caja-qr.dto';
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
  constructor(
    private readonly mercadoPago: MercadoPagoService,
    private readonly alias: VerificacionAliasService,
    private readonly cajas: CajasQrService,
  ) {}

  // Las cajas de MercadoPago por playa, para el QR que se paga desde cualquier banco o billetera.
  @Get('cajas')
  cajasQr() {
    return this.cajas.listar();
  }

  @Post('cajas')
  crearCajaQr(@Body() dto: CrearCajaQrDto, @Req() req: any) {
    const { playaId, ...direccion } = dto;
    return this.cajas.crear(playaId, direccion, this.usuario(req));
  }

  // La verificación de transferencias al alias: activarla y cargar el alias es del administrador
  // (por eso vive acá y no en VerificacionAliasController, que es del mostrador).
  @Get('verificacion-alias')
  verificacionAlias() {
    return this.alias.configuracion();
  }

  @Patch('verificacion-alias')
  configurarVerificacionAlias(
    @Body() dto: ConfigurarVerificacionAliasDto,
    @Req() req: any,
  ) {
    return this.alias.configurar(this.usuario(req), dto);
  }

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

  // Conectar es aceptar las condiciones: sin la versión vigente no sale el link a MercadoPago.
  @Post('conectar')
  conectar(@Body() dto: AceptarCondicionesDto, @Req() req: any) {
    return this.mercadoPago.iniciarConexion(this.usuario(req), dto.condiciones);
  }

  @Post('condiciones')
  aceptarCondiciones(@Body() dto: AceptarCondicionesDto, @Req() req: any) {
    return this.mercadoPago.aceptarCondiciones(
      this.usuario(req),
      dto.condiciones,
    );
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
