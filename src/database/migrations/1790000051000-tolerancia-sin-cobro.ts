import { MigrationInterface, QueryRunner } from 'typeorm';

// El auto que se va antes de la tolerancia no paga, salvo que la playa lo apague en Tarifas.
// Activo por defecto también en las playas existentes. Las estadías que ya están adentro tienen su
// copia de tarifas sin este dato y se cobran como cuando entraron.
export class ToleranciaSinCobro1790000051000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query('ALTER TABLE ticket_schedule_settings ADD COLUMN IF NOT EXISTS "sinCobroEnTolerancia" boolean NOT NULL DEFAULT true');
  }

  async down(r: QueryRunner) {
    await r.query('ALTER TABLE ticket_schedule_settings DROP COLUMN IF EXISTS "sinCobroEnTolerancia"');
  }
}
