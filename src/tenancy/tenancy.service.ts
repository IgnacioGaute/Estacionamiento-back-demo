import { hash } from 'bcryptjs';
import { ConflictException } from '@nestjs/common';
import {
  CreateEmpresaUsuarioDto,
  UpdateEmpresaUsuarioDto,
} from './dto/empresa-usuario.dto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { Empresa } from './entities/empresa.entity';
import { Playa } from './entities/playa.entity';
import { UsuarioPlaya } from './entities/usuario-playa.entity';
import { User } from 'src/users/entities/user.entity';
import { CreateEmpresaDto } from './dto/create-empresa.dto';
import { UpdateEmpresaDto } from './dto/update-empresa.dto';
import { CreatePlayaDto } from './dto/create-playa.dto';
import { UpdatePlayaDto } from './dto/update-playa.dto';
import { AsignarPlayasDto } from './dto/asignar-playas.dto';

// Administración de la plataforma. Todo lo de acá lo usa únicamente el super admin.
@Injectable()
export class TenancyService {
  private readonly logger = new Logger(TenancyService.name);

  constructor(
    @InjectRepository(Empresa)
    private readonly empresaRepository: Repository<Empresa>,
    @InjectRepository(Playa)
    private readonly playaRepository: Repository<Playa>,
    @InjectRepository(UsuarioPlaya)
    private readonly usuarioPlayaRepository: Repository<UsuarioPlaya>,
    @InjectRepository(User) private readonly userRepository: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  async createUsuario(empresaId: string, dto: CreateEmpresaUsuarioDto) {
    if (!(await this.empresaRepository.existsBy({ id: empresaId })))
      throw new NotFoundException('Empresa no encontrada.');
    const usuario = this.userRepository.create({
      ...dto,
      empresaId,
      password: await hash(dto.password, 10),
    });
    return this.guardarUsuario(usuario);
  }

  private async usuarioDeEmpresa(empresaId: string, id: string) {
    const usuario = await this.userRepository.findOneBy({ id, empresaId });
    if (!usuario || usuario.role === 'SUPER_ADMIN')
      throw new NotFoundException('Usuario no encontrado en esta empresa.');
    return usuario;
  }

  async updateUsuario(
    empresaId: string,
    id: string,
    dto: UpdateEmpresaUsuarioDto,
  ) {
    const usuario = await this.usuarioDeEmpresa(empresaId, id);
    const { password, ...datos } = dto;
    Object.assign(usuario, datos);
    if (password) usuario.password = await hash(password, 10);
    return this.guardarUsuario(usuario);
  }

  private async guardarUsuario(usuario: User) {
    try {
      const guardado = await this.userRepository.save(usuario);
      const { password, ...publico } = guardado;
      return publico;
    } catch (error) {
      if (error?.code === '23505')
        throw new ConflictException(
          'El email o el nombre de usuario ya está registrado.',
        );
      throw error;
    }
  }

  async removeUsuario(empresaId: string, id: string) {
    await this.usuarioDeEmpresa(empresaId, id);
    // Conservamos la identidad en el historial de operaciones.
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(UsuarioPlaya).delete({ usuarioId: id });
      await manager.getRepository(User).softDelete(id);
    });
    return { message: 'Usuario dado de baja. Su historial se conserva.' };
  }

  // Una empresa con sus playas y sus usuarios: es la única vista que necesita el super admin.
  async findAllEmpresas() {
    const empresas = await this.empresaRepository.find({
      relations: ['playas'],
      order: { nombre: 'ASC' },
    });
    if (empresas.length === 0) return [];

    const usuarios = await this.userRepository.find({
      where: { empresaId: In(empresas.map((e) => e.id)) },
      order: { firstName: 'ASC' },
    });
    const asignaciones = await this.usuarioPlayaRepository.find({
      where: {
        usuarioId: In(
          usuarios
            .map((u) => u.id)
            .concat('00000000-0000-0000-0000-000000000000'),
        ),
      },
    });

    return empresas.map((empresa) => ({
      ...empresa,
      playas: [...(empresa.playas ?? [])].sort((a, b) =>
        a.nombre.localeCompare(b.nombre),
      ),
      usuarios: usuarios
        .filter((u) => u.empresaId === empresa.id)
        .map((u) => ({
          id: u.id,
          firstName: u.firstName,
          lastName: u.lastName,
          email: u.email,
          username: u.username,
          role: u.role,
          playaIds: asignaciones
            .filter((a) => a.usuarioId === u.id)
            .map((a) => a.playaId),
        })),
    }));
  }

  async createEmpresa(dto: CreateEmpresaDto) {
    const empresa = this.empresaRepository.create({
      nombre: dto.nombre.trim(),
      estado: dto.estado ?? 'ACTIVA',
    });
    return this.empresaRepository.save(empresa);
  }

  async updateEmpresa(id: string, dto: UpdateEmpresaDto) {
    const empresa = await this.empresaRepository.findOne({ where: { id } });
    if (!empresa) throw new NotFoundException('Empresa no encontrada.');
    return this.empresaRepository.save(
      this.empresaRepository.merge(empresa, dto),
    );
  }

  // Borrar una empresa se lleva puestas sus playas y con ellas toda la operación. Se exige que
  // no queden playas ni usuarios: si no, un clic borra meses de tickets y caja sin aviso.
  async removeEmpresa(id: string) {
    const empresa = await this.empresaRepository.findOne({
      where: { id },
      relations: ['playas'],
    });
    if (!empresa) throw new NotFoundException('Empresa no encontrada.');

    if ((empresa.playas ?? []).length > 0) {
      throw new BadRequestException({
        code: 'EMPRESA_CON_PLAYAS',
        message:
          'La empresa tiene playas. Solo se pueden eliminar playas sin registros asociados.',
      });
    }
    const usuarios = await this.userRepository.count({
      where: { empresaId: id },
      withDeleted: true,
    });
    if (usuarios > 0) {
      throw new BadRequestException({
        code: 'EMPRESA_CON_USUARIOS',
        message: `La empresa todavía tiene ${usuarios} usuario(s). Incluye usuarios dados de baja cuyo historial se conserva.`,
      });
    }
    await this.empresaRepository.delete(id);
    return { message: 'Empresa eliminada.' };
  }

  async createPlaya(empresaId: string, dto: CreatePlayaDto) {
    const empresa = await this.empresaRepository.findOne({
      where: { id: empresaId },
    });
    if (!empresa) throw new NotFoundException('Empresa no encontrada.');
    const playa = this.playaRepository.create({
      empresaId,
      nombre: dto.nombre.trim(),
      direccion: dto.direccion?.trim() || null,
    });
    return this.dataSource.transaction(async (manager) => {
      const saved = await manager.getRepository(Playa).save(playa);
      await manager.query(
        `INSERT INTO ticket_vehicle_types ("playaId", code, name, enabled) VALUES ($1, 'AUTO', 'Auto', true)`,
        [saved.id],
      );
      await manager.query(
        `INSERT INTO ticket_price_brackets ("playaId", "vehicleType", "ticketDayType", label, "uptoMinutes", price, "recurringUnitMinutes", "recurringPriceMode")
         VALUES
         ($1, 'AUTO', NULL, 'Ejemplo: hasta 30 minutos', 30, 1000, NULL, 'FIXED'),
         ($1, 'AUTO', NULL, 'Ejemplo: hasta 1 hora', 60, 2000, NULL, 'FIXED'),
         ($1, 'AUTO', NULL, 'Ejemplo: hasta 2 horas', 120, 4000, NULL, 'FIXED'),
         ($1, 'AUTO', NULL, 'Ejemplo: cada hora adicional', NULL, 2000, 60, 'FIXED')`,
        [saved.id],
      );
      return saved;
    });
  }

  async updatePlaya(id: string, dto: UpdatePlayaDto) {
    const playa = await this.playaRepository.findOne({ where: { id } });
    if (!playa) throw new NotFoundException('Playa no encontrada.');
    return this.playaRepository.save(this.playaRepository.merge(playa, dto));
  }

  // No se borra una playa que ya tiene operación cargada: las FK de tickets, caja y turnos no
  // tienen ON DELETE, así que Postgres lo rechazaría igual, pero con un error ilegible.
  async removePlaya(id: string) {
    const playa = await this.playaRepository.findOne({ where: { id } });
    if (!playa) throw new NotFoundException('Playa no encontrada.');

    const enUso = await this.contarOperacion(id);
    if (enUso > 0) {
      throw new BadRequestException({
        code: 'PLAYA_EN_USO',
        message: `La playa tiene ${enUso} registro(s) de operación (tickets, caja o turnos). No se puede borrar.`,
      });
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(UsuarioPlaya).delete({ playaId: id });
      await manager.query(
        'DELETE FROM ticket_vehicle_types WHERE "playaId"=$1',
        [id],
      );
      await manager.getRepository(Playa).delete(id);
    });
    return { message: 'Playa eliminada.' };
  }

  private async contarOperacion(playaId: string): Promise<number> {
    // Incluye también tarifas, cocheras y cualquier entidad futura vinculada a la playa.
    const entidades = this.dataSource.entityMetadatas.filter(
      (meta) =>
        meta.target !== UsuarioPlaya &&
        meta.tableName !== 'ticket_vehicle_types' &&
        meta.columns.some((c) => c.propertyName === 'playaId'),
    );
    let total = 0;
    for (const meta of entidades) {
      total += await this.dataSource
        .getRepository(meta.target)
        .count({ where: { playaId }, withDeleted: true });
    }
    return total;
  }

  // La lista completa de playas del usuario: lo que no venga en el dto se revoca. Se valida que
  // la playa sea de la misma empresa que el usuario, que es la regla que la base todavía no
  // puede garantizar sola.
  async asignarPlayas(usuarioId: string, dto: AsignarPlayasDto) {
    const usuario = await this.userRepository.findOne({
      where: { id: usuarioId },
    });
    if (!usuario) throw new NotFoundException('Usuario no encontrado.');
    if (usuario.role === 'USER' && dto.playaIds.length !== 1)
      throw new BadRequestException('Asigná una sola playa al operador.');
    if (!usuario.empresaId) {
      throw new BadRequestException(
        'El usuario no pertenece a ninguna empresa.',
      );
    }

    if (dto.playaIds.length > 0) {
      const playas = await this.playaRepository.find({
        where: { id: In(dto.playaIds) },
      });
      if (playas.length !== dto.playaIds.length)
        throw new NotFoundException('Alguna playa no existe.');
      const ajenas = playas.filter((p) => p.empresaId !== usuario.empresaId);
      if (ajenas.length > 0) {
        throw new BadRequestException({
          code: 'PLAYA_DE_OTRA_EMPRESA',
          message: 'No podés asignarle a un usuario una playa de otra empresa.',
        });
      }
    }

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(UsuarioPlaya);
      await repo.delete({ usuarioId });
      if (dto.playaIds.length === 0) return [];
      const filas = dto.playaIds.map((playaId) =>
        repo.create({
          usuarioId,
          playaId,
          rolPlaya: dto.rolPlaya ?? 'OPERADOR',
        }),
      );
      return repo.save(filas);
    });
  }
}
