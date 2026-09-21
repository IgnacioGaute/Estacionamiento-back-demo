import { tenantContext } from '../tenancy/tenant-context';
import { UsuarioPlaya } from '../tenancy/entities/usuario-playa.entity';
import { BadRequestException, ForbiddenException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

      const fieldsToUpdate = Object.entries(updateUserDto).reduce(
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

      const updatedUser = this.userRepository.merge(user, fieldsToUpdate);

      if (updateUserDto.password) {
        const hashedPassword = bcrypt.hashSync(updateUserDto.password, 10);
        updatedUser.password = hashedPassword;
      }

      const result = await this.userRepository.save(updatedUser);

      this.logger.log(`User "${result.email}" updated successfully`);
      const { password, ...publicUser } = result;
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
