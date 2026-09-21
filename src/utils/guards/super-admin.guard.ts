import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard } from './auth.guard';
import { AuthenticatedRequest } from '../../types/request';

// Administración de la plataforma: empresas, playas y usuarios de cada empresa.
//
// A diferencia de AuthOrTokenAuthGuard, acá NO se acepta el API_SECRET_TOKEN: ese token es un
// secreto compartido que entra sin usuario, y dar de alta o borrar empresas con él dejaría la
// acción sin responsable. Estas rutas exigen una persona identificada.
@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(@InjectRepository(User) private readonly users: Repository<User>) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const authGuard = new JwtAuthGuard();
    let autenticado = false;
    try {
      autenticado = !!(await authGuard.canActivate(context));
    } catch {
      autenticado = false;
    }
    if (!autenticado) throw new UnauthorizedException('Necesitás iniciar sesión.');

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user?.userId) throw new UnauthorizedException('Necesitás iniciar sesión.');

    // El rol llega con mayúsculas inconsistentes según de dónde venga el token; se normaliza
    // igual que en el frontend para no rebotar a un super admin legítimo.
    const usuario = await this.users.findOneBy({ id: request.user.userId });
    const rol = usuario?.role;
    if (!usuario) throw new UnauthorizedException('La cuenta ya no está disponible.');
    if (rol !== 'SUPER_ADMIN') {
      throw new ForbiddenException({
        code: 'SOLO_SUPER_ADMIN',
        message: 'Esta sección es solo para la administración de la plataforma.',
      });
    }
    return true;
  }
}
