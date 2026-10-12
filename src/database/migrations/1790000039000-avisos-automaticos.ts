import { MigrationInterface, QueryRunner } from 'typeorm';

export class AvisosAutomaticos1790000039000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query(`ALTER TABLE notes ALTER COLUMN description TYPE text,
      ADD COLUMN IF NOT EXISTS "sourceKey" varchar(255),
      ADD COLUMN IF NOT EXISTS origin varchar(120),
      ADD COLUMN IF NOT EXISTS "sourceType" varchar(32),
      ADD COLUMN IF NOT EXISTS "sourceId" uuid,
      ADD COLUMN IF NOT EXISTS context text`);
    await r.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_notes_sourceKey" ON notes ("sourceKey")');
  }
  async down() { throw new Error('Se conservan los avisos y sus referencias originales.'); }
}
