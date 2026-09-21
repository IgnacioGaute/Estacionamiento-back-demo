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
    // La tabla puede venir de dos lados: de esta misma migración (clave primaria
    // `code`) o creada por `synchronize` desde la entidad actual (clave `id` uuid y
    // único por (playaId, code)). Un ON CONFLICT (code) sirve solo para la primera
    // y explota en la segunda, así que la siembra se hace con NOT EXISTS, que no
    // necesita ningún índice, y se completa `id` solo si la columna existe.
    const conId = await runner.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ticket_vehicle_types' AND column_name = 'id'`,
    );
    const columnas = conId.length ? '(id, code, name)' : '(code, name)';
    const valores = conId.length ? 'gen_random_uuid(), v.code, v.name' : 'v.code, v.name';
    await runner.query(`INSERT INTO ticket_vehicle_types ${columnas}
      SELECT ${valores}
      FROM (VALUES ('AUTO', 'Auto'), ('CAMIONETA', 'Camioneta')) AS v(code, name)
      WHERE NOT EXISTS (SELECT 1 FROM ticket_vehicle_types t WHERE t.code = v.code)`);
  }
  async down(): Promise<void> {
    throw new Error('La reversión requiere conciliar los tipos personalizados; no se convierten ni eliminan datos automáticamente.');
  }
}
