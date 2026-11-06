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
import { DataSource } from 'typeorm';
import { cobroSinTurno, exigirTurnoParaSalida } from 'src/turnos/turno-requerido';

// El cobro con QR desde el mostrador. A diferencia de conectar la cuenta —que es del
// administrador— esto lo usa el cajero, así que sus tres handlers están en OPERATOR_ENDPOINTS.
//
// Se exige un usuario real: el pago termina en un movimiento del libro, y el libro no admite
// plata sin responsable.
@UseGuards(AuthOrTokenAuthGuard)
@Controller('mercadopago/cobros')
export class CobrosMercadoPagoController {
  constructor(private readonly cobros: CobrosMercadoPagoService, private readonly ds: DataSource) {}

  private usuario(req: any): string {
    if (!req.user?.userId)
      throw new UnauthorizedException(
        'Esta acción requiere un usuario autenticado.',
      );
    return req.user.userId;
  }

  @Post()
  async crearCobro(@Body() dto: CrearCobroDto, @Req() req: any) {
    const usuario = this.usuario(req);
    // Cobrar una salida (o un anticipo) exige el turno abierto del operador; el pase cobrado al
    // ingresar y la cuenta de un inquilino no (ver exigirTurnoParaSalida). `alIngresar` solo cuenta
    // con ABONO, como en el servicio: con HORA se ignora y no puede saltear el control.
    // La acreditación posterior no pasa por acá.
    if (!cobroSinTurno(dto)) await exigirTurnoParaSalida(this.ds);
    return this.cobros.crear(dto.registrationId, dto.tipo ?? 'HORA', usuario, {
      monto: dto.monto,
      receiptIds: dto.receiptIds,
      nota: dto.nota,
      alIngresar: dto.alIngresar,
      anticipo: dto.anticipoMinutos ? { minutos: dto.anticipoMinutos, etiqueta: dto.anticipoEtiqueta ?? null } : undefined,
    });
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
