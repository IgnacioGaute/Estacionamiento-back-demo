import { MigrationInterface, QueryRunner } from 'typeorm';

export class ParkingReceipts1790000004000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      `ALTER TABLE ticket_registration_for_days ADD COLUMN IF NOT EXISTS "retiredAt" timestamptz`,
    );
    await runner.query(
      `ALTER TABLE ticket_schedule_settings ADD COLUMN IF NOT EXISTS "receiptDelivery" jsonb NOT NULL DEFAULT '{"whatsapp":false,"qr":false,"print":false,"paperWidth":80}'`,
    );
    await runner.query(`CREATE TABLE IF NOT EXISTS parking_receipts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "playaId" uuid NOT NULL REFERENCES playas(id),
      "registrationId" uuid NOT NULL, kind varchar NOT NULL,
      token varchar(64) NOT NULL UNIQUE, snapshot jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
      UNIQUE ("playaId", "registrationId", kind)
    )`);
    await runner.query(
      'ALTER TABLE parking_receipts ENABLE ROW LEVEL SECURITY',
    );
    await runner.query('ALTER TABLE parking_receipts FORCE ROW LEVEL SECURITY');
    const [identity] = await runner.query('SELECT current_user AS name');
    const owner = '"' + identity.name.replace(/"/g, '""') + '"';
    await runner.query(
      'DROP POLICY IF EXISTS parking_system ON parking_receipts',
    );
    await runner.query(
      `CREATE POLICY parking_system ON parking_receipts TO ${owner} USING (true) WITH CHECK (true)`,
    );
    await runner.query(
      'DROP POLICY IF EXISTS parking_isolation ON parking_receipts',
    );
    await runner.query(`CREATE POLICY parking_isolation ON parking_receipts TO parking_scoped
      USING ("playaId" = NULLIF(current_setting('parking.playa', true), '')::uuid)
      WITH CHECK ("playaId" = NULLIF(current_setting('parking.playa', true), '')::uuid)`);
    await runner.query(
      'GRANT SELECT, INSERT ON parking_receipts TO parking_scoped',
    );
    await runner.query(
      `CREATE OR REPLACE TRIGGER parking_b_references BEFORE INSERT OR UPDATE ON parking_receipts FOR EACH ROW EXECUTE FUNCTION parking_check_references()`,
    );
  }
  async down(): Promise<void> {
    throw new Error('Los comprobantes emitidos requieren conservar sus datos.');
  }
}
