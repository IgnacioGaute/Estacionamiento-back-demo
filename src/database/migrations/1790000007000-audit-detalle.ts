import { MigrationInterface, QueryRunner } from 'typeorm';

// El historial guardaba qué se hizo pero no sobre qué valores. Sin esto, «se cambió una tarifa»
// no dice cuál ni a cuánto, que es justo lo que se va a mirar cuando alguien pregunte por qué
// cambió el precio.
export class AuditDetalle1790000007000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(
      'ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS detalle jsonb',
    );
    // El historial se lee siempre por empresa y fecha descendente.
    await runner.query(
      'CREATE INDEX IF NOT EXISTS audit_empresa_fecha ON audit_log ("empresaId", fecha DESC)',
    );
  }

  async down(runner: QueryRunner) {
    await runner.query('DROP INDEX IF EXISTS audit_empresa_fecha');
    await runner.query('ALTER TABLE audit_log DROP COLUMN IF EXISTS detalle');
  }
}
