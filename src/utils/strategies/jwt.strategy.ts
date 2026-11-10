import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { ExtractJwt } from 'passport-jwt';
import { Injectable, Logger, UnauthorizedException, ForbiddenException } from '@nestjs/common';
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
  private readonly logger = new Logger(JwtStrategy.name);

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
    // Suspendida sigue entrando: tiene que ver por qué y poder sacar los autos que quedaron adentro.
    // Qué puede hacer lo decide TenantGuard con SUSPENDED_ENDPOINTS. De baja no entra.
    const empresaEstado = user.empresa?.estado ?? null;
    if (user.role !== 'SUPER_ADMIN' && empresaEstado !== 'ACTIVA' && empresaEstado !== 'SUSPENDIDA')
      throw new ForbiddenException('Tu empresa no está activa.');
    this.anotarAcceso(user);
    return { userId: user.id, email: user.email, username: user.username, role: user.role, empresaEstado };
  }

  // El último acceso que ve el super admin en la ficha de la empresa. El usuario ya se leyó para
  // validar el token, así que decidir no cuesta nada; se escribe como mucho cada 10 minutos para
  // no sumar un UPDATE a cada pedido. SQL directo para no tocar `updatedAt`, que es «la última vez
  // que se editó la cuenta». Sin await: anotar el acceso nunca demora ni hace fallar el pedido.
  private anotarAcceso(user: User) {
    const ultimo = user.lastAccessAt ? new Date(user.lastAccessAt).getTime() : 0;
    if (Date.now() - ultimo < ACCESO_CADA_MS) return;
    this.users
      .query(
        `UPDATE users SET "lastAccessAt" = now()
         WHERE id = $1 AND ("lastAccessAt" IS NULL OR "lastAccessAt" < now() - interval '10 minutes')`,
        [user.id],
      )
      .catch((error: unknown) =>
        this.logger.warn(`No se pudo anotar el acceso de ${user.id}: ${error instanceof Error ? error.message : error}`),
      );
  }
}

const ACCESO_CADA_MS = 10 * 60 * 1000;
