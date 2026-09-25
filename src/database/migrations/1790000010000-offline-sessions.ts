import { MigrationInterface, QueryRunner } from 'typeorm';
export class OfflineSessions1790000010000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query(`CREATE TABLE IF NOT EXISTS offline_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "playaId" uuid NOT NULL REFERENCES playas(id), "userId" uuid NOT NULL REFERENCES users(id), "deviceId" uuid NOT NULL, active boolean NOT NULL DEFAULT true, "createdAt" timestamptz NOT NULL, "expiresAt" timestamptz NOT NULL, snapshot jsonb NOT NULL, processed jsonb NOT NULL DEFAULT '{}')`);
    await r.query('CREATE UNIQUE INDEX IF NOT EXISTS offline_one_device ON offline_sessions ("playaId") WHERE active');
    await r.query('ALTER TABLE offline_sessions ENABLE ROW LEVEL SECURITY');
    await r.query('ALTER TABLE offline_sessions FORCE ROW LEVEL SECURITY');
    const [owner] = await r.query('SELECT current_user AS name');
    await r.query(`CREATE POLICY parking_system ON offline_sessions TO "${owner.name.replace(/"/g, '""')}" USING (true) WITH CHECK (true)`);
    await r.query(`CREATE POLICY parking_isolation ON offline_sessions TO parking_scoped USING ("playaId" = NULLIF(current_setting('parking.playa', true), '')::uuid) WITH CHECK ("playaId" = NULLIF(current_setting('parking.playa', true), '')::uuid)`);
    await r.query('GRANT SELECT, INSERT, UPDATE ON offline_sessions TO parking_scoped');
  }
  async down() { throw new Error('Las operaciones de contingencia deben conservarse.'); }
}
