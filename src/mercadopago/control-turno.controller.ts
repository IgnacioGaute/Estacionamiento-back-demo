import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthOrTokenAuthGuard } from 'src/utils/guards/auth-or-token.guard';
import { AuthenticatedRequest } from 'src/types/request';
import { ControlTurnoMercadoPagoService } from './control-turno.service';

// El control de Mercado Pago de un turno: lo pide el cierre (operador responsable o administrador)
// después de comparar el conteo, y el historial para reintentar una consulta que falló. Está en
// OPERATOR_ENDPOINTS y en SUSPENDED_ENDPOINTS, como la conciliación de la caja.
@UseGuards(AuthOrTokenAuthGuard)
@Controller('mercadopago/turnos')
export class ControlTurnoController {
  constructor(private readonly control: ControlTurnoMercadoPagoService) {}

  @Get(':id/control')
  async controlDelTurno(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    if (!req.user?.userId)
      throw new UnauthorizedException('Esta acción requiere un usuario autenticado.');
    return { control: await this.control.consultar(id, req.user.userId, req.user.role) };
  }
}
