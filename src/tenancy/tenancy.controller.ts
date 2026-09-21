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
  Post,
  UseGuards,
} from '@nestjs/common';
import { TenancyService } from './tenancy.service';
import { SuperAdminGuard } from 'src/utils/guards/super-admin.guard';
import { CreateEmpresaDto } from './dto/create-empresa.dto';
import { UpdateEmpresaDto } from './dto/update-empresa.dto';
import { CreatePlayaDto } from './dto/create-playa.dto';
import { UpdatePlayaDto } from './dto/update-playa.dto';
import { AsignarPlayasDto } from './dto/asignar-playas.dto';

// Administración de la plataforma. El guard exige super admin en TODAS las rutas y, a
// diferencia del resto del backend, no acepta el token estático.
@Controller('tenancy')
@UseGuards(SuperAdminGuard)
export class TenancyController {
  constructor(private readonly tenancyService: TenancyService) {}

  @Post('empresas/:empresaId/usuarios')
  createUsuario(
    @Param('empresaId') empresaId: string,
    @Body() dto: CreateEmpresaUsuarioDto,
  ) {
    return this.tenancyService.createUsuario(empresaId, dto);
  }

  @Patch('empresas/:empresaId/usuarios/:id')
  updateUsuario(
    @Param('empresaId') empresaId: string,
    @Param('id') id: string,
    @Body() dto: UpdateEmpresaUsuarioDto,
  ) {
    return this.tenancyService.updateUsuario(empresaId, id, dto);
  }

  @Delete('empresas/:empresaId/usuarios/:id')
  removeUsuario(
    @Param('empresaId') empresaId: string,
    @Param('id') id: string,
  ) {
    return this.tenancyService.removeUsuario(empresaId, id);
  }

  @Get('empresas')
  findAllEmpresas() {
    return this.tenancyService.findAllEmpresas();
  }

  @Post('empresas')
  createEmpresa(@Body() dto: CreateEmpresaDto) {
    return this.tenancyService.createEmpresa(dto);
  }

  @Patch('empresas/:id')
  updateEmpresa(@Param('id') id: string, @Body() dto: UpdateEmpresaDto) {
    return this.tenancyService.updateEmpresa(id, dto);
  }

  @Delete('empresas/:id')
  removeEmpresa(@Param('id') id: string) {
    return this.tenancyService.removeEmpresa(id);
  }

  @Post('empresas/:empresaId/playas')
  createPlaya(
    @Param('empresaId') empresaId: string,
    @Body() dto: CreatePlayaDto,
  ) {
    return this.tenancyService.createPlaya(empresaId, dto);
  }

  @Patch('playas/:id')
  updatePlaya(@Param('id') id: string, @Body() dto: UpdatePlayaDto) {
    return this.tenancyService.updatePlaya(id, dto);
  }

  @Delete('playas/:id')
  removePlaya(@Param('id') id: string) {
    return this.tenancyService.removePlaya(id);
  }

  @Patch('usuarios/:usuarioId/playas')
  asignarPlayas(
    @Param('usuarioId') usuarioId: string,
    @Body() dto: AsignarPlayasDto,
  ) {
    return this.tenancyService.asignarPlayas(usuarioId, dto);
  }
}
