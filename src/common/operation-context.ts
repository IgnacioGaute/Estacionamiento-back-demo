import { AsyncLocalStorage } from 'node:async_hooks';
import { DataSource, EntityManager } from 'typeorm';

// Una reproducción offline comparte la transacción exterior y el momento del hecho.
// Fuera de ella, los servicios conservan su transacción y reloj habituales.
export const operationContext = new AsyncLocalStorage<{
  manager: EntityManager;
  at: Date;
  resourceId: string;
  cashSessionId?: string;
  shiftId: string | null;
  snapshot: any;
  afterCommit: (() => void)[];
}>();
export const operationNow = () => operationContext.getStore()?.at ?? new Date();
export function operationTransaction<T>(source: DataSource, work: (manager: EntityManager) => Promise<T>): Promise<T> {
  const context = operationContext.getStore();
  return context ? work(context.manager) : source.transaction(work);
}
