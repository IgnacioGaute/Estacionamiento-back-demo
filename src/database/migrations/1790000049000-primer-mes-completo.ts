import { MigrationInterface, QueryRunner } from 'typeorm';

export class PrimerMesCompleto1790000049000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE suscripciones ADD COLUMN IF NOT EXISTS "primerMesCompleto" boolean NOT NULL DEFAULT false',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE suscripciones DROP COLUMN IF EXISTS "primerMesCompleto"',
    );
  }
}
