import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { AuthOrTokenAuthGuard } from 'src/utils/guards/auth-or-token.guard';
import { AuthenticatedRequest } from 'src/types/request';
import { listPagination } from 'src/utils/list-pagination';
import { CorreccionesService } from './correcciones.service';
import { HistorialService } from './historial.service';
import { CorreccionDto, ResolverCorreccionDto } from './dto/correccion.dto';

function actor(req: AuthenticatedRequest) {
  if (!req.user?.userId) throw new UnauthorizedException('Esta acción requiere un usuario autenticado.');
  return { usuarioId: req.user.userId, rol: req.user.role };
}

// El historial de movimientos de la playa y las correcciones de registros (docs/correcciones.md).
// Todos los roles que operan pueden consultar y pedir correcciones; quién las aplica lo decide el
// servicio (no el botón). Resolver las pendientes es de administración: `resolverCorreccion` no
// está en OPERATOR_ENDPOINTS.
@Controller('operaciones')
@UseGuards(AuthOrTokenAuthGuard)
export class OperacionesController {
  constructor(private readonly correcciones: CorreccionesService, private readonly historial: HistorialService) {}

  @Get()
  historialMovimientos(@Req() req: AuthenticatedRequest, @Query() q: Record<string, string | undefined>) {
    return this.historial.listar({ desde: q.desde, hasta: q.hasta, turnoId: q.turnoId, operadorId: q.operadorId, q: q.q, medio: q.medio, tipo: q.tipo, correccion: q.correccion },
      listPagination(q.page, q.limit), actor(req));
  }

  @Get('estadias/:id')
  detalleEstadia(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.correcciones.detalleEstadia(id, actor(req));
  }

  @Get('pases/:id')
  detallePase(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.correcciones.detallePase(id, actor(req));
  }

  // Las transferencias de Mercado Pago que pueden respaldar el cambio de un efectivo a transferencia.
  @Get('correcciones/transferencias')
  transferenciasParaCorreccion(@Req() req: AuthenticatedRequest, @Query('movimientoId', ParseUUIDPipe) movimientoId: string, @Query('importe') importe?: string) {
    const monto = importe === undefined ? undefined : Number(importe);
    if (monto !== undefined && !(Number.isInteger(monto) && monto > 0)) throw new BadRequestException('Importe inválido.');
    return this.correcciones.transferenciasPara(movimientoId, monto, actor(req));
  }

  @Post('correcciones/previsualizar')
  previsualizarCorreccion(@Req() req: AuthenticatedRequest, @Body() dto: CorreccionDto) {
    return this.correcciones.previsualizar(dto, actor(req));
  }

  @Post('correcciones')
  corregir(@Req() req: AuthenticatedRequest, @Body() dto: CorreccionDto) {
    return this.correcciones.crear(dto, actor(req));
  }

  @Patch('correcciones/:id')
  resolverCorreccion(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolverCorreccionDto) {
    return this.correcciones.resolver(id, dto, actor(req));
  }
}
