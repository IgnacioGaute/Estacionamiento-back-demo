import { UserRole } from 'src/users/entities/user.entity';

export interface RequestWithRawBody extends Request {
  rawBody: string;
}

export interface AuthenticatedRequest extends Request {
  user: {
    userId?: string;
    email?: string;
    username?: string;
    role?: UserRole;
    // Estado de la empresa al validar el token (null para el super admin).
    empresaEstado?: 'ACTIVA' | 'SUSPENDIDA' | 'BAJA' | null;
  };
}
