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
  };
}
