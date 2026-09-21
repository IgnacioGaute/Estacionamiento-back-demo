import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { TurnosService } from './turnos.service';
import { OpenTurnoDto } from './dto/open-turno.dto';
import { CloseTurnoDto } from './dto/close-turno.dto';
import { AuthOrTokenAuthGuard } from 'src/utils/guards/auth-or-token.guard';
import { AuthenticatedRequest } from 'src/types/request';
import { UnauthorizedException } from '@nestjs/common';

function requireUserId(req: AuthenticatedRequest): string {
  if (!req.user?.userId) {
    throw new UnauthorizedException('Esta acción requiere un usuario autenticado.');
  }
  return req.user.userId;
}

@Controller('turnos')
@UseGuards(AuthOrTokenAuthGuard)
export class TurnosController {
  constructor(private readonly turnosService: TurnosService) {}

  @Post('open')
  open(@Req() req: AuthenticatedRequest, @Body() dto: OpenTurnoDto) {
    return this.turnosService.open(requireUserId(req), dto);
  }

  @Patch(':id/close')
  close(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: CloseTurnoDto) {
    return this.turnosService.close(id, requireUserId(req), dto, req.user?.role);
  }

  @Get('caja')
  getCashContext() { return this.turnosService.getCashContext(); }

  @Get()
  findAll(
    @Query('estado') estado?: 'ABIERTO' | 'CERRADO',
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('usuarioId') usuarioId?: string,
    @Query('fechaPor') fechaPor?: 'APERTURA' | 'CIERRE',
  ) {
    return this.turnosService.findAll({ estado, desde, hasta, usuarioId, fechaPor });
  }

  @Get('operadores')
  findOperadores() {
    return this.turnosService.findOperadores();
  }

  @Get('mine/open')
  getMyOpenTurno(@Req() req: AuthenticatedRequest) {
    return this.turnosService.findOpenTurnoOrNull(requireUserId(req));
  }
}
