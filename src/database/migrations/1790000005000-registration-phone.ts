import { MigrationInterface, QueryRunner } from 'typeorm';

export class RegistrationPhone1790000005000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE ticket_registrations ADD COLUMN IF NOT EXISTS "phoneCustomer" varchar(15)`);
  }
  async down(): Promise<void> {
    throw new Error('Los teléfonos guardados requieren conservar sus datos.');
  }
}
