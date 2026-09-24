import { MigrationInterface, QueryRunner } from 'typeorm';

export class OperationSettings1790000006000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "ticket_schedule_settings" ADD COLUMN IF NOT EXISTS "shiftsEnabled" boolean NOT NULL DEFAULT true');
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "ticket_schedule_settings" DROP COLUMN "shiftsEnabled"');
  }
}
