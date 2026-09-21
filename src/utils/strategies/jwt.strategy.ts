import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { ExtractJwt } from 'passport-jwt';
import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User, UserRole } from 'src/users/entities/user.entity';

type JWT = {
  id?: string;
  email?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  role?: UserRole;
  exp?: number;
  authVersion?: number;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService, @InjectRepository(User) private readonly users: Repository<User>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: configService.get('NEXTAUTH_SECRET'),
      algorithms: ['HS256'],
    });
  }

  async validate(payload: JWT | undefined) {
    if (!payload?.id || typeof payload.exp !== 'number') throw new UnauthorizedException();
    const user = await this.users.findOne({ where: { id: payload.id }, relations: ['empresa'] });
    if (!user) throw new UnauthorizedException('La cuenta ya no está disponible.');
    if ((payload.authVersion ?? 0) !== user.authVersion) throw new UnauthorizedException('Volvé a iniciar sesión.');
    if (user.role !== 'SUPER_ADMIN' && user.empresa?.estado !== 'ACTIVA') throw new ForbiddenException('Tu empresa no está activa.');
    return { userId: user.id, email: user.email, username: user.username, role: user.role };
  }
}
