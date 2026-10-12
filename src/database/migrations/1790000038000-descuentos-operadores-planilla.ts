import { MigrationInterface, QueryRunner } from 'typeorm';

export class DescuentosOperadoresPlanilla1790000038000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query("ALTER TYPE movimientos_tipo_enum ADD VALUE IF NOT EXISTS 'DESCUENTO'");
    for (const table of ['other_payments', 'receipt_payments', 'payments_history_on_account']) {
      await r.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "operatorName" varchar(255)`);
    }
    await r.query('ALTER TABLE ticket_registration_for_days ADD COLUMN IF NOT EXISTS "paymentOperatorName" varchar(255)');
  }
  async down() { throw new Error('Se conservan los descuentos y los operadores registrados.'); }
}
