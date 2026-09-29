import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReceiptOperators1790000020000 implements MigrationInterface {
  async up(r: QueryRunner) {
    for (const table of ['ticket_registrations', 'ticket_registration_for_days']) {
      await r.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "entryOperatorName" varchar(255)`);
      await r.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "exitOperatorName" varchar(255)`);
    }
  }

  async down(r: QueryRunner) {
    for (const table of ['ticket_registrations', 'ticket_registration_for_days']) {
      await r.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS "exitOperatorName"`);
      await r.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS "entryOperatorName"`);
    }
  }
}
