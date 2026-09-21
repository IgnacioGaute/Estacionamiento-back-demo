import { MigrationInterface, QueryRunner } from 'typeorm';

export class NoteReaders1790000003000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // IF NOT EXISTS porque en una base creada desde cero por `synchronize` la
    // columna ya viene de la entidad, y sin esto la migración corta el arranque.
    await queryRunner.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS "readBy" uuid[] NOT NULL DEFAULT '{}'`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE notes DROP COLUMN "readBy"`);
  }
}
