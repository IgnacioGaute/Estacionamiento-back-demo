import { EntityManager } from 'typeorm';
import { User } from 'src/users/entities/user.entity';
import { tenantContext } from 'src/tenancy/tenant-context';

export async function usuariosConSueldoConfigurable(manager: EntityManager) {
  const query = manager.getRepository(User).createQueryBuilder('u')
    .select(['u.id', 'u.firstName', 'u.lastName', 'u.username'])
    .where("u.role IN ('ADMIN', 'USER')");
  const scope = tenantContext.getStore();
  if (scope?.empresaId) query.andWhere('u.empresaId = :empresaId', { empresaId: scope.empresaId });
  if (scope?.playaId) query.andWhere("(u.role = 'ADMIN' OR EXISTS (SELECT 1 FROM usuario_playas up WHERE up.\"usuarioId\" = u.id AND up.\"playaId\" = :playaId))", { playaId: scope.playaId });
  return query.orderBy('u.firstName', 'ASC').addOrderBy('u.id', 'ASC').getMany();
}
