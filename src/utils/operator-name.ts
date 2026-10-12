import { EntityManager } from 'typeorm';
import { User } from 'src/users/entities/user.entity';
import { tenantContext } from 'src/tenancy/tenant-context';

export async function operatorName(manager: EntityManager, id = tenantContext.getStore()?.userId) {
  if (!id) return null;
  const user = await manager.getRepository(User).findOne({ where: { id }, withDeleted: true });
  return user ? [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.username : null;
}
