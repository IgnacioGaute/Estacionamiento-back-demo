import { AsyncLocalStorage } from 'node:async_hooks';
import { DataSource } from 'typeorm';

export interface TenantScope { empresaId: string; playaId: string; userId: string; role?: string; platform?: boolean }
export const tenantContext = new AsyncLocalStorage<TenantScope>();

/** Every QueryRunner owns one pool connection. Set its scope before its first query,
 * including explicit transactions and raw SQL; erase it before returning it to the pool.
 * No SQL rewriting, and no global mutable "current tenant".
 */
export function installTenantConnections(ds: DataSource) {
  ds.subscribers.push({ beforeInsert(event) {
    const scope = tenantContext.getStore();
    if (!scope || !event.entity) return;
    const column = event.metadata.tableName === 'users' ? 'empresaId' : 'playaId';
    if (event.metadata.findColumnWithPropertyName(column) && event.entity[column] == null) {
      event.entity[column] = column === 'empresaId' ? scope.empresaId : scope.playaId;
    }
  } });
  const create = ds.createQueryRunner.bind(ds);
  ds.createQueryRunner = (mode) => {
    const runner = create(mode);
    const scope = tenantContext.getStore();
    const connect = runner.connect.bind(runner);
    const release = runner.release.bind(runner);
    let initialized: Promise<any> | undefined;
    runner.connect = () => initialized ??= (async () => {
      const connection = await connect();
      await connection.query('RESET ROLE');
      await connection.query(`SELECT set_config('parking.empresa', $1, false), set_config('parking.playa', $2, false), set_config('parking.platform', $3, false)`,
        [scope?.empresaId ?? '', scope?.playaId ?? '', scope?.platform ? 'yes' : 'no']);
      if (scope) await connection.query('SET ROLE parking_scoped');
      return connection;
    })();
    runner.release = async () => {
      if (runner.isReleased) return;
      try {
        if (initialized) {
          const connection = await initialized;
          // A failed transaction must not contaminate the next checkout.
          if (runner.isTransactionActive) await connection.query('ROLLBACK');
          await connection.query('RESET ROLE');
          await connection.query(`SELECT set_config('parking.empresa', '', false), set_config('parking.playa', '', false), set_config('parking.platform', 'no', false)`);
        }
      } finally { await release(); }
    };
    return runner;
  };
}
