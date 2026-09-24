import {
  CreateEmpresaUsuarioDto,
  UpdateEmpresaUsuarioDto,
} from './dto/empresa-usuario.dto';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { TenancyService } from './tenancy.service';
import { SuperAdminGuard } from 'src/utils/guards/super-admin.guard';
import { CreateEmpresaDto } from './dto/create-empresa.dto';
import { UpdateEmpresaDto } from './dto/update-empresa.dto';
import { CreatePlayaDto } from './dto/create-playa.dto';
import { UpdatePlayaDto } from './dto/update-playa.dto';
import { AsignarPlayasDto } from './dto/asignar-playas.dto';
import { AuthenticatedRequest } from 'src/types/request';

// Administración de la plataforma. El guard exige super admin en TODAS las rutas y, a
// diferencia del resto del backend, no acepta el token estático.
//
// Cada mutación deja su rastro en audit_log DESPUÉS de completarse: si la acción falla no hay
// nada que registrar, y si el registro falla la acción no se revierte (registrarAuditoria no
// propaga errores). Es un historial, no un libro contable: para la plata está `movimientos`.
@Controller('tenancy')
@UseGuards(SuperAdminGuard)
export class TenancyController {
  constructor(private readonly tenancyService: TenancyService) {}

  private actor(req: AuthenticatedRequest) {
    return req.user?.userId ?? null;
  }

  @Post('empresas/:empresaId/usuarios')
  async createUsuario(
    @Req() req: AuthenticatedRequest,
    @Param('empresaId') empresaId: string,
    @Body() dto: CreateEmpresaUsuarioDto,
  ) {
    const usuario = await this.tenancyService.createUsuario(empresaId, dto);
    await this.tenancyService.registrarAuditoria({
      empresaId,
      usuarioId: this.actor(req),
      accion: 'USUARIO_CREADO',
      entidad: usuario.email,
      entidadId: usuario.id,
    });
    return usuario;
  }

  @Patch('empresas/:empresaId/usuarios/:id')
  async updateUsuario(
    @Req() req: AuthenticatedRequest,
    @Param('empresaId') empresaId: string,
    @Param('id') id: string,
    @Body() dto: UpdateEmpresaUsuarioDto,
  ) {
    const usuario = await this.tenancyService.updateUsuario(empresaId, id, dto);
    await this.tenancyService.registrarAuditoria({
      empresaId,
      usuarioId: this.actor(req),
      accion: dto.password ? 'USUARIO_CONTRASENA' : 'USUARIO_EDITADO',
      entidad: usuario.email,
      entidadId: id,
    });
    return usuario;
  }

  @Delete('empresas/:empresaId/usuarios/:id')
  async removeUsuario(
    @Req() req: AuthenticatedRequest,
    @Param('empresaId') empresaId: string,
    @Param('id') id: string,
  ) {
    const resultado = await this.tenancyService.removeUsuario(empresaId, id);
    await this.tenancyService.registrarAuditoria({
      empresaId,
      usuarioId: this.actor(req),
      accion: 'USUARIO_BAJA',
      entidad: 'usuario',
      entidadId: id,
    });
    return resultado;
  }

  @Get('empresas')
  findAllEmpresas() {
    return this.tenancyService.findAllEmpresas();
  }

  // Métricas de operación de todas las playas. `dias` acota la ventana de lo cobrado.
  @Get('metrics')
  metrics(@Query('dias') dias?: string) {
    return this.tenancyService.metrics(Number(dias) || 30);
  }

  // Serie diaria, medios de pago y actividad por hora para la pantalla de métricas.
  @Get('metrics/detalle')
  metricsDetalle(
    @Query('dias') dias?: string,
    @Query('empresaId') empresaId?: string,
  ) {
    return this.tenancyService.metricsDetalle(
      Number(dias) || 30,
      empresaId || undefined,
    );
  }

  @Get('empresas/:id')
  findEmpresa(@Param('id') id: string) {
    return this.tenancyService.findEmpresa(id);
  }

  @Get('empresas/:id/actividad')
  actividad(@Param('id') id: string, @Query('limite') limite?: string) {
    return this.tenancyService.actividadDeEmpresa(id, Number(limite) || 40);
  }

  @Get('empresas/:id/eliminacion')
  resumenEliminacionEmpresa(@Param('id') id: string) {
    return this.tenancyService.resumenEliminacionEmpresa(id);
  }

  @Get('playas/:id/eliminacion')
  resumenEliminacionPlaya(@Param('id') id: string) {
    return this.tenancyService.resumenEliminacionPlaya(id);
  }

  @Post('empresas')
  async createEmpresa(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateEmpresaDto,
  ) {
    const empresa = await this.tenancyService.createEmpresa(dto);
    await this.tenancyService.registrarAuditoria({
      empresaId: empresa.id,
      usuarioId: this.actor(req),
      accion: 'EMPRESA_CREADA',
      entidad: empresa.nombre,
      entidadId: empresa.id,
    });
    return empresa;
  }

  @Patch('empresas/:id')
  async updateEmpresa(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateEmpresaDto,
  ) {
    const empresa = await this.tenancyService.updateEmpresa(id, dto);
    await this.tenancyService.registrarAuditoria({
      empresaId: id,
      usuarioId: this.actor(req),
      // Suspender o reactivar no es lo mismo que corregir el nombre: se distinguen porque son
      // las que explican por qué una empresa dejó de poder entrar al sistema.
      accion: dto.estado ? `EMPRESA_${dto.estado}` : 'EMPRESA_EDITADA',
      entidad: empresa.nombre,
      entidadId: id,
    });
    return empresa;
  }

  @Delete('empresas/:id')
  async removeEmpresa(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const resultado = await this.tenancyService.removeEmpresa(id);
    await this.tenancyService.registrarAuditoria({
      empresaId: id,
      usuarioId: this.actor(req),
      accion: 'EMPRESA_ELIMINADA',
      entidad: 'empresa',
      entidadId: id,
    });
    return resultado;
  }

  @Post('empresas/:empresaId/playas')
  async createPlaya(
    @Req() req: AuthenticatedRequest,
    @Param('empresaId') empresaId: string,
    @Body() dto: CreatePlayaDto,
  ) {
    const playa = await this.tenancyService.createPlaya(empresaId, dto);
    await this.tenancyService.registrarAuditoria({
      empresaId,
      playaId: playa.id,
      usuarioId: this.actor(req),
      accion: 'PLAYA_CREADA',
      entidad: playa.nombre,
      entidadId: playa.id,
    });
    return playa;
  }

  @Patch('playas/:id')
  async updatePlaya(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdatePlayaDto,
  ) {
    const playa = await this.tenancyService.updatePlaya(id, dto);
    await this.tenancyService.registrarAuditoria({
      empresaId: playa.empresaId,
      playaId: playa.id,
      usuarioId: this.actor(req),
      accion: 'PLAYA_EDITADA',
      entidad: playa.nombre,
      entidadId: playa.id,
    });
    return playa;
  }

  @Delete('playas/:id')
  async removePlaya(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const resultado = await this.tenancyService.removePlaya(id);
    await this.tenancyService.registrarAuditoria({
      empresaId: resultado.empresaId,
      usuarioId: this.actor(req),
      accion: 'PLAYA_ELIMINADA',
      entidad: resultado.nombre,
      entidadId: id,
    });
    return { message: resultado.message };
  }

  @Patch('usuarios/:usuarioId/playas')
  async asignarPlayas(
    @Req() req: AuthenticatedRequest,
    @Param('usuarioId') usuarioId: string,
    @Body() dto: AsignarPlayasDto,
  ) {
    const asignaciones = await this.tenancyService.asignarPlayas(
      usuarioId,
      dto,
    );
    const empresaId = await this.tenancyService.empresaDeUsuario(usuarioId);
    if (empresaId)
      await this.tenancyService.registrarAuditoria({
        empresaId,
        usuarioId: this.actor(req),
        accion: 'USUARIO_PLAYAS',
        entidad: 'asignación',
        entidadId: usuarioId,
      });
    return asignaciones;
  }
}
