import { tenantContext, TenantScope } from '../tenancy/tenant-context';
import { UsuarioPlaya } from '../tenancy/entities/usuario-playa.entity';
import { BadRequestException, ForbiddenException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User, UserRole } from './entities/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { FilterOperator, paginate, Paginated, PaginateQuery } from 'nestjs-paginate';
import { UpdatePasswordDto } from './dto/update-password.dto';


@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async create(createUserDto: CreateUserDto) {
    try {
      const existingUserEmail = await this.userRepository.findOne({
        where: { email: createUserDto.email },
      });

      if (existingUserEmail) {
        throw new ConflictException('email already exists');
      }

      const existingUserName = await this.userRepository.findOne({
        where: { username: createUserDto.username },
      });

      if (existingUserName) {
        throw new ConflictException('username already exists');
      }
      const user = this.userRepository.create(createUserDto);

      if (createUserDto.password) {
        const hashedPassword = bcrypt.hashSync(createUserDto.password, 10);
        user.password = hashedPassword;
      }

      return await this.userRepository.manager.transaction(async manager => {
        const saved = await manager.getRepository(User).save(user);
        const scope = tenantContext.getStore();
        if (scope) await manager.getRepository(UsuarioPlaya).save({ usuarioId: saved.id, playaId: scope.playaId, rolPlaya: saved.role === 'ADMIN' ? 'ENCARGADO' : 'OPERADOR' });
        const { password, ...publico } = saved;
        return publico;
      });
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
      throw error;
    }
  }

  async findAll(query: PaginateQuery): Promise<Paginated<User>> {
    try {
      return await paginate(query, this.userRepository, {
        sortableColumns: ['id', 'username', 'email'],
        nullSort: 'last',
        defaultSortBy: [['createdAt', 'DESC']],
        searchableColumns: ['username', 'email'],
        filterableColumns: {
          username: [FilterOperator.ILIKE, FilterOperator.EQ],
          email: [FilterOperator.EQ, FilterOperator.ILIKE],
        },
      });
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
      throw error;
    }
  }

  async findOne(id: string) {
    try {
      const user = await this.userRepository.findOne({
        where: { id },
        relations: ['empresa'],
      });

      if (!user) {
        throw new NotFoundException('User not found');
      }

      if (user.role !== 'SUPER_ADMIN' && user.empresa?.estado !== 'ACTIVA') throw new ForbiddenException('Tu empresa no está activa.');
      const { empresa, ...publicUser } = user;
      return publicUser;
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  async update(id: string, updateUserDto: UpdateUserDto) {
    try {
      const user = await this.userRepository.findOne({ where: { id } });

      if (!user) {
        throw new NotFoundException('User not found');
      }

      if (user.role === 'SUPER_ADMIN') throw new ForbiddenException('Esta cuenta se administra fuera del panel de usuarios de empresa.');

      const { playaId, ...cambios } = updateUserDto;
      const fieldsToUpdate = Object.entries(cambios).reduce(
        (acc, [key, value]) => {
          if (value !== undefined && value !== user[key]) {
            acc[key] = value;
          }
          return acc;
        },
        {} as Partial<UpdateUserDto>,
      );

      if (fieldsToUpdate.username) {
        const existingUser = await this.userRepository.findOne({
          where: { username: fieldsToUpdate.username },
        });

        if (existingUser && existingUser.id !== id) {
          throw new BadRequestException({
            code: 'USER_NAME_ALREDY_EXISTS',
            message: 'User name already exists',
          });
        }
      }

      const nuevoRol = fieldsToUpdate.role;
      const updatedUser = this.userRepository.merge(user, fieldsToUpdate);

      if (updateUserDto.password) {
        const hashedPassword = bcrypt.hashSync(updateUserDto.password, 10);
        updatedUser.password = hashedPassword;
      }

      // usuario_playas y turnos se filtran por la playa actual (RLS): con ese scope no se verían
      // las asignaciones ni los turnos de las otras playas. El cambio de rol corre fuera del scope,
      // como las asignaciones de TenantAccessService, y cada consulta queda atada a la empresa de
      // la cuenta, que el findOne de arriba (con RLS) ya confirmó que es la de quien la cambia.
      const scope = tenantContext.getStore();
      const result = nuevoRol
        ? await tenantContext.exit(() => this.userRepository.manager.transaction(async (m) => {
            await this.cambiarRol(m, scope, user.id, user.empresaId, nuevoRol, playaId);
            const guardado = await m.getRepository(User).save(updatedUser);
            // El rol viaja en la sesión del frontend (menús, rutas): se cierran sus sesiones para
            // que vuelva a entrar con el rol nuevo. El backend ya lo lee de la base en cada pedido.
            await m.query('UPDATE users SET "authVersion" = "authVersion" + 1 WHERE id = $1', [user.id]);
            return guardado;
          }))
        : await this.userRepository.save(updatedUser);

      this.logger.log(`User "${result.email}" updated successfully`);
      const { password, ...publicUser } = result;
      return publicUser;
    } catch (error: any) {
      if (
        !(
          error instanceof NotFoundException ||
          error instanceof BadRequestException ||
          error instanceof ConflictException ||
          error instanceof ForbiddenException
        )
      ) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  // Pasar de operador a administrador o al revés. Se bloquean todos los administradores de la
  // empresa (y la cuenta) para que dos administradores que se bajan el rol a la vez no dejen la
  // empresa sin ninguno, y se relee todo dentro de la transacción.
  private async cambiarRol(m: EntityManager, scope: TenantScope | undefined, id: string, empresaId: string | null, nuevoRol: UserRole, playaId?: string) {
    if (scope?.userId === id)
      throw new ConflictException({ code: 'ROL_PROPIO', message: 'No podés cambiar tu propio rol: pedíselo a otro administrador.' });
    if (!empresaId || (!scope?.platform && scope?.empresaId !== empresaId))
      throw new ForbiddenException('Esta cuenta se administra fuera del panel de usuarios de empresa.');

    const admins: { id: string }[] = await m.query(
      `SELECT id FROM users WHERE "empresaId" = $1 AND role = 'ADMIN' AND "deletedAt" IS NULL ORDER BY id FOR UPDATE`,
      [empresaId],
    );
    const [cuenta] = await m.query(
      'SELECT role FROM users WHERE id = $1 AND "empresaId" = $2 AND "deletedAt" IS NULL FOR UPDATE',
      [id, empresaId],
    );
    if (!cuenta) throw new NotFoundException('User not found');
    // Otro administrador le pudo haber sacado el rol a quien hace el cambio mientras tanto.
    if (scope?.role === 'ADMIN' && !admins.some((a) => a.id === scope.userId))
      throw new ForbiddenException('Ya no sos administrador de esta empresa.');

    if (nuevoRol === 'ADMIN') {
      // Mismo rol por playa que al crear un administrador; conserva las playas que ya tenía.
      await m.query(`UPDATE usuario_playas SET "rolPlaya" = 'ENCARGADO' WHERE "usuarioId" = $1`, [id]);
      return;
    }

    if (cuenta.role === 'ADMIN' && !admins.some((a) => a.id !== id))
      throw new ConflictException({ code: 'ULTIMO_ADMIN', message: 'La empresa tiene que tener al menos un administrador.' });

    // El operador entra a una sola playa: la elegida, la única que ya tenía o la única de la empresa.
    let destino = playaId;
    if (destino) {
      const [playa] = await m.query('SELECT id FROM playas WHERE id = $1 AND "empresaId" = $2', [destino, empresaId]);
      if (!playa) throw new ForbiddenException('La playa no pertenece a la empresa del usuario.');
    } else {
      const propias: { playaId: string }[] = await m.query(
        `SELECT up."playaId" FROM usuario_playas up JOIN playas p ON p.id = up."playaId" AND p."empresaId" = $2 WHERE up."usuarioId" = $1`,
        [id, empresaId],
      );
      const empresa: { id: string }[] = await m.query('SELECT id FROM playas WHERE "empresaId" = $1', [empresaId]);
      destino = propias.length === 1 ? propias[0].playaId : empresa.length === 1 ? empresa[0].id : undefined;
      if (!destino)
        throw new BadRequestException({ code: 'PLAYA_REQUERIDA', message: 'Elegí la playa en la que va a operar.' });
    }

    // Un turno abierto en otra playa quedaría sin poder cerrarse: el operador solo ve la suya.
    const [turno] = await m.query(
      `SELECT count(*)::int AS n FROM turnos WHERE "usuarioAperturaId" = $1 AND estado = 'ABIERTO' AND "playaId" IS DISTINCT FROM $2`,
      [id, destino],
    );
    if (turno.n > 0)
      throw new ConflictException({ code: 'TURNO_ABIERTO', message: 'Tiene un turno abierto en otra playa: tiene que cerrarlo antes de pasar a operador.' });

    await m.query('DELETE FROM usuario_playas WHERE "usuarioId" = $1', [id]);
    await m.query(`INSERT INTO usuario_playas ("usuarioId", "playaId", "rolPlaya") VALUES ($1, $2, 'OPERADOR')`, [id, destino]);
  }

  async remove(id: string) {
    try {
      const user = await this.userRepository.findOne({ where: { id } });

      if (!user) {
        throw new NotFoundException('User not found');
      }

      if (user.role === 'SUPER_ADMIN') throw new ForbiddenException('No se puede eliminar la cuenta de la plataforma desde esta sección.');
      await this.userRepository.remove(user);

      return { message: 'User removed successfully' };
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  async updatePassword(id: string, updatePasswordDto: UpdatePasswordDto) {
    try {
      const { currentPassword, newPassword, repeatNewPassword } =
        updatePasswordDto;

      if (newPassword !== repeatNewPassword) {
        throw new BadRequestException('Passwords do not match');
      }

      const user = await this.userRepository
        .createQueryBuilder('user')
        .addSelect('user.password')
        .where({ id })
        .getOne();

      if (!user) {
        throw new NotFoundException('User not found');
      }

      const isMatch = !!user.password && await bcrypt.compare(currentPassword, user.password);

      if (!isMatch) {
        throw new BadRequestException({
          code: 'CURRENT_PASSWORD_INCORRECT',
          message: 'Current password is incorrect',
        });
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10);
      user.password = hashedPassword;

      const saved = await this.userRepository.save(user);
      const { password, ...publicUser } = saved;
      return publicUser;
    } catch (error: any) {
      if (
        !(
          error instanceof NotFoundException ||
          error instanceof BadRequestException
        )
      ) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

}
