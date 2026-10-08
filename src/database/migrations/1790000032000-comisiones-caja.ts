import { MigrationInterface, QueryRunner } from 'typeorm';

export class ComisionesCaja1790000032000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query(`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS "comisionQrPorcentaje" numeric(5,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "comisionTransferenciaPorcentaje" numeric(5,2) NOT NULL DEFAULT 0`);
    await r.query(`ALTER TABLE empresas ADD CONSTRAINT comisiones_caja_rango CHECK (
      "comisionQrPorcentaje" BETWEEN 0 AND 100 AND "comisionTransferenciaPorcentaje" BETWEEN 0 AND 100)`);
    const [role] = await r.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'parking_scoped') AS present");
    if (role.present) {
      // Sólo estas columnas; el aislamiento por empresa sigue a cargo de la política RLS.
      // TypeORM actualiza updatedAt automáticamente junto con el porcentaje.
      await r.query('GRANT UPDATE ("comisionQrPorcentaje", "comisionTransferenciaPorcentaje", "updatedAt") ON empresas TO parking_scoped');
    }
  }
  async down(r: QueryRunner) {
    const [role] = await r.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'parking_scoped') AS present");
    if (role.present) await r.query('REVOKE UPDATE ("comisionQrPorcentaje", "comisionTransferenciaPorcentaje", "updatedAt") ON empresas FROM parking_scoped');
    await r.query(`ALTER TABLE empresas DROP CONSTRAINT comisiones_caja_rango,
      DROP COLUMN "comisionQrPorcentaje", DROP COLUMN "comisionTransferenciaPorcentaje"`);
  }
}
