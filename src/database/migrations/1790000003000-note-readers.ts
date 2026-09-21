import { MigrationInterface, QueryRunner } from 'typeorm';

export class NoteReaders1790000003000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE notes ADD COLUMN "readBy" uuid[] NOT NULL DEFAULT '{}'`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE notes DROP COLUMN "readBy"`);
  }
}
