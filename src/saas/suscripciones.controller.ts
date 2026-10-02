import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SuperAdminGuard } from 'src/utils/guards/super-admin.guard';
import { AuthenticatedRequest } from 'src/types/request';
import { SuscripcionesService } from './suscripciones.service';
import { CobrosPlataformaService } from './cobros-plataforma.service';
import {
  AnularPagoSaasDto,
  AsignarPlanDto,
  EditarPlanDto,
  EditarSuscripcionDto,
  ActivarCuentaDto,
  PagosSaasQueryDto,
  DiasExtraDto,
  RegistrarPagoSaasDto,
} from './dto/suscripciones.dto';

// Planes y cuentas de las empresas con la plataforma: lo que vos les cobrás. Igual que
// TenancyController, exige super admin en todas las rutas, no acepta el token estático (cada
// cambio queda a nombre de una persona) y no pasa por el TenantInterceptor: el super admin no
// tiene empresa y acá se trabaja sobre cualquiera.
@Controller('tenancy')
@UseGuards(SuperAdminGuard)
export class SuscripcionesController {
  constructor(
    private readonly suscripciones: SuscripcionesService,
    private readonly cobros: CobrosPlataformaService,
  ) {}

  private actor(req: AuthenticatedRequest) {
    return req.user?.userId ?? null;
  }

  @Get('planes')
  planes() {
    return this.suscripciones.planes();
  }

  @Patch('planes/:id')
  editarPlan(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarPlanDto,
  ) {
    return this.suscripciones.editarPlan(id, dto);
  }

  // Pagos de todas las empresas en un rango: lo cobrado en el mes.
  @Get('suscripciones/pagos')
  pagos(@Query() query: PagosSaasQueryDto) {
    return this.suscripciones.pagos(query.desde, query.hasta);
  }

  // Corre ahora la misma revisión que la tarea diaria: asentar lo pagado por MercadoPago, emitir
  // facturas y suspender lo que pasó la gracia.
  @Post('suscripciones/revisar')
  async revisar() {
    const { acreditados } = await this.cobros.conciliarTodas();
    return { ...(await this.suscripciones.revisarVencimientos()), acreditados };
  }

  @Get('empresas/:id/suscripcion')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.suscripciones.detalle(id);
  }

  @Patch('empresas/:id/suscripcion')
  editar(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarSuscripcionDto,
  ) {
    return this.suscripciones.editar(id, dto, this.actor(req));
  }

  @Put('empresas/:id/suscripcion/playas/:playaId')
  async asignarPlan(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('playaId', ParseUUIDPipe) playaId: string,
    @Body() dto: AsignarPlanDto,
  ) {
    const detalle = await this.suscripciones.asignarPlan(
      id,
      playaId,
      dto,
      this.actor(req),
    );
    // Si tiene débito automático, MercadoPago tiene que cobrar el importe nuevo. Si falla, la
    // revisión periódica lo vuelve a intentar: no vale la pena frenar el cambio de plan por eso.
    await this.cobros.sincronizarImporte(id).catch(() => undefined);
    return detalle;
  }

  // Da de alta la cuenta: fecha de alta y días de prueba gratis (aunque todavía no tenga plan).
  @Post('empresas/:id/suscripcion/alta')
  activar(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActivarCuentaDto,
  ) {
    return this.suscripciones.activar(id, dto, this.actor(req));
  }

  // Más tiempo sin pagar: alarga la prueba si nunca pagó, o es una prórroga si ya paga.
  @Post('empresas/:id/suscripcion/dias-extra')
  diasExtra(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DiasExtraDto,
  ) {
    return this.suscripciones.diasExtra(
      id,
      dto.hasta,
      dto.motivo,
      this.actor(req),
    );
  }

  @Post('empresas/:id/suscripcion/pagos')
  registrarPago(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegistrarPagoSaasDto,
  ) {
    return this.suscripciones.registrarPago(id, dto, this.actor(req));
  }

  @Post('empresas/:id/suscripcion/pagos/:facturaId/anular')
  anularPago(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('facturaId', ParseUUIDPipe) facturaId: string,
    @Body() dto: AnularPagoSaasDto,
  ) {
    return this.suscripciones.anularPago(
      id,
      facturaId,
      dto.motivo,
      this.actor(req),
    );
  }
}
