import { MigrationInterface, QueryRunner } from 'typeorm';

const quote = (s: string) => '"' + s.replace(/"/g, '""') + '"';

// audit_log quedó fuera de TenantIsolation: sin GRANT, el rol `parking_scoped` —con el que corre
// toda ruta operativa— no podía insertar, así que los cambios hechos desde el panel de una playa
// no se registraban (el interceptor los intentaba y quedaban en un warning).
//
// Se le dan los permisos mínimos y se la aísla como al resto: cada empresa solo ve y escribe sus
// propias filas. SELECT e INSERT y nada más: un historial de auditoría no se edita ni se borra,
// y sin UPDATE ni DELETE eso lo garantiza la base y no la buena conducta del código.
export class AuditPermisos1790000008000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    const [identity] = await runner.query('SELECT current_user AS name');
    const platform = `current_setting('parking.platform', true) = 'yes'`;
    const scope = `"empresaId" = NULLIF(current_setting('parking.empresa', true), '')::uuid`;

    await runner.query('ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY');
    await runner.query('ALTER TABLE audit_log FORCE ROW LEVEL SECURITY');
    await runner.query('DROP POLICY IF EXISTS parking_isolation ON audit_log');
    await runner.query('DROP POLICY IF EXISTS parking_system ON audit_log');
    await runner.query(
      `CREATE POLICY parking_system ON audit_log TO ${quote(identity.name)} USING (true) WITH CHECK (true)`,
    );
    await runner.query(
      `CREATE POLICY parking_isolation ON audit_log TO parking_scoped USING (${platform} OR (${scope})) WITH CHECK (${platform} OR (${scope}))`,
    );
    await runner.query('GRANT SELECT, INSERT ON audit_log TO parking_scoped');
  }

  async down(runner: QueryRunner) {
    await runner.query('REVOKE SELECT, INSERT ON audit_log FROM parking_scoped');
    await runner.query('DROP POLICY IF EXISTS parking_isolation ON audit_log');
    await runner.query('DROP POLICY IF EXISTS parking_system ON audit_log');
    await runner.query('ALTER TABLE audit_log NO FORCE ROW LEVEL SECURITY');
    await runner.query('ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY');
  }
}
