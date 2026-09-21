import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { VerificationToken } from './entity/verification-token.entity';
import { PasswordResetToken } from './entity/password-reset-token.entity';
import { User } from 'src/users/entities/user.entity';
import { Repository } from 'typeorm';
import { LoginUserDto } from './dto/login-user';
import { CreatePasswordResetTokenDto } from './dto/create-password-reset-token.dto';
import { CreateVerificationTokenDto } from './dto/create-verification-token.dto';
import { UsersService } from 'src/users/users.service';
import { CustomUnauthorizedException } from 'src/libs/helpers/custom-excepcions';
import * as crypto from 'crypto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { limitLogin } from './login-limiter';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(VerificationToken)
    private readonly verificationTokenRepository: Repository<VerificationToken>,
    @InjectRepository(PasswordResetToken)
    private readonly passwordResetTokenRepository: Repository<PasswordResetToken>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>
  ) {}

  async login(loginUserDto: LoginUserDto): Promise<User> {
    try {
      let whereClause = {};

      if (/\S+@\S+\.\S+/.test(loginUserDto.identifier)) {
        whereClause = { email: loginUserDto.identifier };
      } else {
        whereClause = { username: loginUserDto.identifier };
      }

      const user = await this.userRepository.findOne({
        where: whereClause,
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
          email: true,
          password: true,
          role: true,
          authVersion: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (!user?.password) throw new UnauthorizedException('Email o contraseña incorrectos.');

      const passwordsMatch = await bcrypt.compare(
        loginUserDto.password,
        user.password,
      );

      if (!passwordsMatch) {
        throw new UnauthorizedException('Email o contraseña incorrectos.');
      }
      if (user.role !== 'SUPER_ADMIN') {
        const current = await this.userRepository.findOne({ where: { id: user.id }, relations: ['empresa'] });
        if (current?.empresa?.estado !== 'ACTIVA') throw new UnauthorizedException('La cuenta no tiene acceso a una empresa activa.');
      }

      const { password, ...userWithoutPassword } = user; // eslint-disable-line

      return userWithoutPassword as User;
    } catch (error: any) {
      if (!(error instanceof UnauthorizedException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  async getVerificationTokenByEmail(email: string): Promise<VerificationToken> {
    try {
      const verificationToken = await this.verificationTokenRepository.findOne({
        where: { email },
      });

      if (!verificationToken) {
        throw new NotFoundException(
          `Verification token for email ${email} not found`,
        );
      }

      return verificationToken;
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  async resetPassword(dto: ResetPasswordDto) {
    return this.userRepository.manager.transaction(async manager => {
      const tokens = manager.getRepository(PasswordResetToken);
      const token = await tokens.findOne({ where: { token: dto.token }, lock: { mode: 'pessimistic_write' } });
      if (!token || token.expiresAt.getTime() <= Date.now()) throw new UnauthorizedException('El enlace no es válido o venció.');
      const users = manager.getRepository(User);
      const user = await users.findOne({ where: { email: token.email }, lock: { mode: 'pessimistic_write' } });
      if (!user) throw new UnauthorizedException('El enlace no es válido o venció.');
      await users.update(user.id, { password: await bcrypt.hash(dto.password, 10) });
      await tokens.delete(token.id);
      return { success: true };
    });
  }

  async getVerificationTokenByToken(token: string): Promise<VerificationToken> {
    try {
      const verificationToken = await this.verificationTokenRepository.findOne({
        where: { token },
      });

      if (!verificationToken) {
        throw new NotFoundException('Verification token not found');
      }

      return verificationToken;
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  async getPasswordResetTokenByToken(
    token: string,
  ): Promise<PasswordResetToken> {
    try {
      const passwordResetToken =
        await this.passwordResetTokenRepository.findOne({
          where: { token },
        });

      if (!passwordResetToken) {
        throw new NotFoundException('Password reset token not found');
      }

      return passwordResetToken;
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  async getPasswordResetTokenByEmail(
    email: string,
  ): Promise<PasswordResetToken> {
    try {
      const passwordResetToken =
        await this.passwordResetTokenRepository.findOne({
          where: { email },
        });

      if (!passwordResetToken) {
        throw new NotFoundException(
          `Password reset token for email ${email} not found`,
        );
      }

      return passwordResetToken;
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  async createVerificationToken(
    createVerificationTokenDto: CreateVerificationTokenDto,
  ): Promise<VerificationToken> {
    try {
      const existingVerificationToken =
        await this.verificationTokenRepository.findOne({
          where: { email: createVerificationTokenDto.email },
        });

      if (existingVerificationToken) {
        await this.verificationTokenRepository.remove(
          existingVerificationToken,
        );
      }

      const token = crypto.randomUUID();
      const expiresAt = new Date(new Date().getTime() + 1000 * 60 * 60); // 1 hour

      const verificationToken = this.verificationTokenRepository.create({
        email: createVerificationTokenDto.email,
        token,
        expiresAt,
      });

      await this.verificationTokenRepository.save(verificationToken);

      return verificationToken;
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
      throw error;
    }
  }

  async createPasswordResetToken(
    createPasswordResetTokenDto: CreatePasswordResetTokenDto,
  ): Promise<PasswordResetToken> {
    limitLogin('password-reset', createPasswordResetTokenDto.email);
    try {
      const existingPasswordResetToken =
        await this.passwordResetTokenRepository.findOne({
          where: { email: createPasswordResetTokenDto.email },
        });

      if (existingPasswordResetToken) {
        await this.passwordResetTokenRepository.remove(
          existingPasswordResetToken,
        );
      }

      const token = crypto.randomUUID();
      const expiresAt = new Date(new Date().getTime() + 1000 * 60 * 60); // 1 hour

      const passwordResetToken = this.passwordResetTokenRepository.create({
        email: createPasswordResetTokenDto.email,
        token,
        expiresAt,
      });

      await this.passwordResetTokenRepository.save(passwordResetToken);

      return passwordResetToken;
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
      throw error;
    }
  }

  async deleteVerificationToken(id: string): Promise<{ message: string }> {
    try {
      const verificationToken = await this.verificationTokenRepository.findOne({
        where: { id },
      });

      if (!verificationToken) {
        throw new NotFoundException(`Verification token ${id} not found`);
      }

      await this.verificationTokenRepository.remove(verificationToken);

      return { message: 'Verification token deleted' };
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  async deletePasswordResetToken(id: string): Promise<{ message: string }> {
    try {
      const passwordResetToken =
        await this.passwordResetTokenRepository.findOne({
          where: { id },
        });

      if (!passwordResetToken) {
        throw new NotFoundException(`Password reset token ${id} not found`);
      }

      await this.passwordResetTokenRepository.remove(passwordResetToken);

      return { message: 'Password reset token deleted' };
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  private comparePasswords(password: string, hashedPassword: string) {
    return bcrypt.compareSync(password, hashedPassword);
  }
}
