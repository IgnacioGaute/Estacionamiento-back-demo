import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { AuthenticatedRequest } from 'src/types/request';
import { CuentasService } from './cuentas.service';
import { hoy } from './libro';
import {
  AbonosQueryDto,
  AjusteDto,
  AnulacionesQueryDto,
  AnularDto,
  CargarAbonosDto,
  DevolucionDto,
  RegistrarPagoDto,
  SaldoInicialDto,
} from './dto/cuentas.dto';

// Cuenta corriente de inquilinos. El operador ve la lista y, de cada inquilino, lo que debe y lo
// que pagó (`mostrador`), y cobra (ver endpoint-policy). El estado de cuenta completo, saldo
// inicial, ajustes, devoluciones, anulaciones (y su listado) y cargar los abonos del mes, sólo
// administración.
@Controller('cuentas')
export class CuentasController {
  constructor(private readonly cuentas: CuentasService) {}

  // Todo lo que mueve plata queda firmado por una persona.
  private usuario(req: AuthenticatedRequest) {
    const id = req.user?.userId;
    if (!id) throw new UnauthorizedException('Iniciá sesión con tu usuario para operar la cuenta.');
    return id;
  }

  @Get('resumen')
  resumen() {
    return this.cuentas.resumen();
  }

  // Antes que ':customerId', que si no se queda con «anulaciones» y lo rechaza por no ser uuid.
  @Get('anulaciones')
  anulaciones(@Query() query: AnulacionesQueryDto) {
    return this.cuentas.anulaciones(query.mes ?? hoy().slice(0, 7));
  }

  // Qué se cargaría al confirmar los abonos de un mes, sin cargar nada.
  @Get('abonos/previsualizar')
  previsualizarAbonos(@Query() query: AbonosQueryDto) {
    return this.cuentas.previsualizarAbonos(query.mes);
  }

  @Get(':customerId')
  estado(@Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.cuentas.estado(customerId);
  }

  // Lo que debe y lo que pagó, sin el libro: lo único de la cuenta que ve el operador.
  @Get(':customerId/mostrador')
  mostrador(@Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.cuentas.mostrador(customerId);
  }

  @Post(':customerId/pagos')
  registrarPago(
    @Req() req: AuthenticatedRequest,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: RegistrarPagoDto,
  ) {
    return this.cuentas.registrarPago(customerId, dto, this.usuario(req));
  }

  // El recibo del pago como comprobante público (QR, WhatsApp o térmica, según la configuración
  // de la playa). Lo usa quien cobró, así que también el operador (ver endpoint-policy).
  @Post('pagos/:id/comprobante')
  emitirComprobante(@Param('id', ParseUUIDPipe) id: string) {
    return this.cuentas.emitirComprobante(id);
  }

  @Post(':customerId/saldo-inicial')
  registrarSaldoInicial(
    @Req() req: AuthenticatedRequest,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: SaldoInicialDto,
  ) {
    return this.cuentas.registrarSaldoInicial(customerId, dto, this.usuario(req));
  }

  @Post(':customerId/ajustes')
  registrarAjuste(
    @Req() req: AuthenticatedRequest,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: AjusteDto,
  ) {
    return this.cuentas.registrarAjuste(customerId, dto, this.usuario(req));
  }

  @Post(':customerId/devoluciones')
  registrarDevolucion(
    @Req() req: AuthenticatedRequest,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: DevolucionDto,
  ) {
    return this.cuentas.registrarDevolucion(customerId, dto, this.usuario(req));
  }

  @Post('movimientos/:id/anular')
  anular(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnularDto,
  ) {
    return this.cuentas.anular(id, dto, this.usuario(req));
  }

  @Post('abonos/cargar')
  cargarAbonos(@Req() req: AuthenticatedRequest, @Body() dto: CargarAbonosDto) {
    return this.cuentas.cargarAbonos(dto.mes, dto.vencimientoDia, this.usuario(req));
  }
}
