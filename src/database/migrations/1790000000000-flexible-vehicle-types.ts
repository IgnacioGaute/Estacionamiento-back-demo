import { MigrationInterface, QueryRunner } from 'typeorm';

// Debe ejecutarse antes de synchronize: ALTER TYPE conserva valores y relaciones.
export class FlexibleVehicleTypes1790000000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    for (const table of ['tickets', 'tickets-price', 'ticket_price_brackets', 'ticket_registrations', 'ticket_registration_for_days']) {
      const rows = await runner.query(`SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'vehicleType'`, [table]);
      if (rows[0]?.data_type === 'USER-DEFINED') {
        await runner.query(`ALTER TABLE "${table}" ALTER COLUMN "vehicleType" TYPE varchar(32) USING "vehicleType"::text`);
      }
    }
    await runner.query(`CREATE TABLE IF NOT EXISTS ticket_vehicle_types (code varchar(32) PRIMARY KEY, name varchar(80) NOT NULL, enabled boolean NOT NULL DEFAULT true)`);
    await runner.query(`INSERT INTO ticket_vehicle_types (code, name) VALUES ('AUTO', 'Auto'), ('CAMIONETA', 'Camioneta') ON CONFLICT (code) DO NOTHING`);
  }
  async down(): Promise<void> {
    throw new Error('La reversión requiere conciliar los tipos personalizados; no se convierten ni eliminan datos automáticamente.');
  }
}
