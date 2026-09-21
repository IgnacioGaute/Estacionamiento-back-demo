import { Body, Param, Patch, BadRequestException } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import {
  CallHandler,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  NestInterceptor,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Observable } from 'rxjs';
import { JwtAuthGuard } from '../utils/guards/auth.guard';
import { tenantContext, TenantScope } from './tenant-context';
import { OPERATOR_ENDPOINTS } from './endpoint-policy';
import { limitLogin } from '../auth/login-limiter';

class AssignOperatorPlayaDto {
  @IsUUID('4') playaId: string;
}

@Injectable()
export class TenantAccessService {
  constructor(private readonly ds: DataSource) {}
  async context(userId: string) {
    const [user] = await this.ds.query(
      'SELECT id, role, "empresaId", "authVersion" FROM users WHERE id=$1 AND "deletedAt" IS NULL',
      [userId],
    );
    if (!user) throw new UnauthorizedException();
    if (user.role === 'SUPER_ADMIN')
      return {
        user,
        empresa: null,
        playas: await this.ds.query(
          'SELECT id, nombre, "empresaId" FROM playas ORDER BY nombre',
        ),
      };
    const [empresa] = await this.ds.query(
      "SELECT id,nombre FROM empresas WHERE id=$1 AND estado='ACTIVA'",
      [user.empresaId],
    );
    if (!empresa)
      throw new ForbiddenException('Tu cuenta no tiene una empresa activa.');
    const playas = await this.ds.query(
      `SELECT p.id,p.nombre,p."empresaId" FROM playas p WHERE p."empresaId"=$1 AND ($2='ADMIN' OR EXISTS(SELECT 1 FROM usuario_playas up WHERE up."playaId"=p.id AND up."usuarioId"=$3)) ORDER BY p.nombre,p.id`,
      [empresa.id, user.role, user.id],
    );
    return { user, empresa, playas };
  }
  async operatorAssignment(
    actorId: string,
    operatorId: string,
    playaId?: string,
  ) {
    // This administration endpoint has no operational scope. Always validate both accounts
    // and company ownership before reading or changing assignments.
    return this.ds.transaction(async (manager) => {
      const [actor] = await manager.query(
        'SELECT role,"empresaId" FROM users WHERE id=$1 AND "deletedAt" IS NULL',
        [actorId],
      );
      if (!actor || !['ADMIN', 'SUPER_ADMIN'].includes(actor.role))
        throw new ForbiddenException(
          'Solo un administrador puede asignar playas.',
        );
      const [operator] = await manager.query(
        'SELECT id,role,"empresaId" FROM users WHERE id=$1 AND "deletedAt" IS NULL FOR UPDATE',
        [operatorId],
      );
      if (
        !operator ||
        operator.role !== 'USER' ||
        !operator.empresaId ||
        (actor.role !== 'SUPER_ADMIN' && actor.empresaId !== operator.empresaId)
      )
        throw new ForbiddenException('No podés administrar este operador.');
      const playas = await manager.query(
        'SELECT id,nombre FROM playas WHERE "empresaId"=$1 ORDER BY nombre,id',
        [operator.empresaId],
      );
      if (playaId !== undefined) {
        if (!playas.some((p) => p.id === playaId))
          throw new ForbiddenException(
            'La playa no pertenece a la empresa del operador.',
          );
        await manager.query('DELETE FROM usuario_playas WHERE "usuarioId"=$1', [
          operatorId,
        ]);
        await manager.query(
          `INSERT INTO usuario_playas ("usuarioId","playaId","rolPlaya") VALUES ($1,$2,'OPERADOR')`,
          [operatorId, playaId],
        );
      }
      const assignments = await manager.query(
        'SELECT "playaId" FROM usuario_playas WHERE "usuarioId"=$1',
        [operatorId],
      );
      return {
        playas,
        playaId: assignments.length === 1 ? assignments[0].playaId : null,
      };
    });
  }
  async resolve(userId: string, requested?: string): Promise<TenantScope> {
    const context = await this.context(userId);
    if (context.user.role === 'USER' && context.playas.length !== 1)
      throw new ForbiddenException(
        'El administrador debe asignarte una playa.',
      );
    const playa = requested
      ? context.playas.find((p) => p.id === requested)
      : context.playas.length === 1
        ? context.playas[0]
        : undefined;
    if (!playa)
      throw new ForbiddenException(
        requested
          ? 'No tenés acceso a esa playa.'
          : 'Elegí una playa para continuar.',
      );
    return {
      userId,
      role: context.user.role,
      empresaId: playa.empresaId,
      playaId: playa.id,
      platform: context.user.role === 'SUPER_ADMIN',
    };
  }
}

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  async canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest();
    const controller = context.getClass().name;
    const handler = context.getHandler().name;
    const serviceSecret = this.config.getOrThrow<string>('API_SECRET_TOKEN');
    if (controller === 'AuthController' && handler === 'login') {
      limitLogin(req.ip ?? req.socket?.remoteAddress ?? 'unknown', req.body?.identifier);
      return true;
    }
    if (controller === 'AuthController') {
      if (
        req.headers.authorization !==
        `Bearer ${serviceSecret}`
      )
        throw new UnauthorizedException();
      return true;
    }
    // Trusted server-side account lookup used by NextAuth, never by operational APIs.
    const staticToken =
      req.headers.authorization ===
      `Bearer ${serviceSecret}`;
    if (controller === 'UsersController' && staticToken && ['findAll', 'findOne'].includes(handler)) {
      req.platformAccountService = true;
      return true;
    }
    if (!(await new JwtAuthGuard().canActivate(context)))
      throw new UnauthorizedException();
    if (controller === 'UsersController') {
      const self =
        req.params.id === req.user.userId && ['findOne', 'updatePassword'].includes(handler);
      if (!self && !['ADMIN', 'SUPER_ADMIN'].includes(req.user.role))
        throw new ForbiddenException(
          'Solo el administrador gestiona usuarios.',
        );
    } else if (req.user.role === 'USER' && !OPERATOR_ENDPOINTS[controller]?.includes(handler)) {
      throw new ForbiddenException('Esta acción requiere un administrador.');
    }
    return true;
  }
}

@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(private readonly access: TenantAccessService) {}
  async intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    const controller = context.getClass().name;
    if (
      ['AuthController', 'TenancyController', 'TenantContextController'].includes(controller) ||
      req.platformAccountService
    )
      return next.handle();
    if (!req.user?.userId) throw new UnauthorizedException();
    const raw = req.headers['x-playa-id'];
    if (
      raw !== undefined &&
      (typeof raw !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw))
    )
      throw new ForbiddenException('Playa inválida.');
    const scope = await this.access.resolve(req.user.userId, raw);
    return new Observable((subscriber) =>
      tenantContext.run(scope, () => {
        const subscription = next.handle().subscribe(subscriber);
        return () => subscription.unsubscribe();
      }),
    );
  }
}

@Controller('tenant')
export class TenantContextController {
  constructor(private readonly access: TenantAccessService) {}
  @Get('operators/:id/playa')
  assignment(@Req() req: any, @Param('id') id: string) {
    return this.access.operatorAssignment(req.user.userId, id);
  }
  @Patch('operators/:id/playa')
  assign(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: AssignOperatorPlayaDto,
  ) {
    return this.access.operatorAssignment(req.user.userId, id, dto.playaId);
  }
  @Get('context')
  async context(@Req() req: any) {
    const { user, empresa, playas } = await this.access.context(
      req.user.userId,
    );
    return { role: user.role, empresa, playas };
  }
}
