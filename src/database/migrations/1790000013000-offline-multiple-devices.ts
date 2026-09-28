import { MigrationInterface, QueryRunner } from 'typeorm';
export class OfflineMultipleDevices1790000013000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query('DROP INDEX IF EXISTS offline_one_device');
    await r.query('CREATE INDEX IF NOT EXISTS offline_device_sessions ON offline_sessions ("playaId", "userId", "deviceId") WHERE active');
  }
  async down() { throw new Error('No se deben descartar sesiones con operaciones pendientes.'); }
}
