import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthOrTokenAuthGuard } from 'src/utils/guards/auth-or-token.guard';
import { VerificacionAliasService } from './verificacion-alias.service';
import {
  AsignarTransferenciaDto,
  IniciarCobroAliasDto,
} from './dto/verificacion-alias.dto';

// El cobro por transferencia al alias desde el mostrador. Lo usa el cajero, así que sus handlers
// están en OPERATOR_ENDPOINTS (y en SUSPENDED_ENDPOINTS: cobrar la salida de un auto que quedó
// adentro sigue permitido con la empresa suspendida). Que la empresa tenga el adicional y lo haya
// activado lo verifica el servicio en cada pedido.
//
// Se exige un usuario real: el cobro termina en un movimiento del libro, que no admite pagos sin
// responsable.
@UseGuards(AuthOrTokenAuthGuard)
@Controller('mercadopago/alias')
export class VerificacionAliasController {
  constructor(private readonly alias: VerificacionAliasService) {}

  @Get('disponibilidad')
  disponibilidad(@Req() req: any) {
    usuario(req);
    return this.alias.disponibilidad();
  }

  @Post('cobros')
  iniciarCobro(@Req() req: any, @Body() dto: IniciarCobroAliasDto) {
    usuario(req);
    return this.alias.iniciar(dto.registrationId);
  }

  @Get('cobros/estadia/:registrationId')
  cobroDeEstadia(
    @Req() req: any,
    @Param('registrationId', ParseUUIDPipe) registrationId: string,
  ) {
    usuario(req);
    return this.alias.deEstadia(registrationId);
  }

  @Get('cobros/:id')
  consultarCobro(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    usuario(req);
    return this.alias.consultar(id);
  }

  @Post('cobros/:id/asignar')
  asignarTransferencia(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AsignarTransferenciaDto,
  ) {
    usuario(req);
    return this.alias.asignar(id, dto.operacionId);
  }

  @Post('cobros/:id/ampliar')
  ampliarBusqueda(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    usuario(req);
    return this.alias.ampliar(id);
  }

  @Post('cobros/:id/cancelar')
  cancelarCobro(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    usuario(req);
    return this.alias.cancelar(id);
  }
}

function usuario(req: any) {
  if (!req.user?.userId)
    throw new UnauthorizedException(
      'Esta acción requiere un usuario autenticado.',
    );
}
