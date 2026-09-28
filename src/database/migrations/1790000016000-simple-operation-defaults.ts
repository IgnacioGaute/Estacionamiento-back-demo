import { MigrationInterface, QueryRunner } from 'typeorm';

// Cambia solo el valor inicial: se conservan las preferencias guardadas,
// incluidas las playas con tickets fisicos o turnos habilitados.
export class SimpleOperationDefaults1790000016000 implements MigrationInterface {
  async up(queryRunner: QueryRunner) {
    await queryRunner.query(
      'ALTER TABLE "ticket_schedule_settings" ALTER COLUMN "barcodeTicketsEnabled" SET DEFAULT false',
    );
    await queryRunner.query(
      'ALTER TABLE "ticket_schedule_settings" ALTER COLUMN "shiftsEnabled" SET DEFAULT false',
    );
  }

  async down(queryRunner: QueryRunner) {
    await queryRunner.query(
      'ALTER TABLE "ticket_schedule_settings" ALTER COLUMN "barcodeTicketsEnabled" SET DEFAULT true',
    );
    await queryRunner.query(
      'ALTER TABLE "ticket_schedule_settings" ALTER COLUMN "shiftsEnabled" SET DEFAULT true',
    );
  }
}
