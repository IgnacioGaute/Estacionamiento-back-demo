import { MigrationInterface, QueryRunner } from 'typeorm';

export class AuthVersion1790000002000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS "authVersion" integer NOT NULL DEFAULT 0');
    // Password changes revoke all existing sessions, including updates made by an administrator.
    await runner.query(`CREATE OR REPLACE FUNCTION parking_revoke_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.password IS DISTINCT FROM OLD.password THEN NEW."authVersion" := OLD."authVersion" + 1; END IF;
        RETURN NEW;
      END $$`);
    await runner.query('CREATE OR REPLACE TRIGGER parking_revoke_sessions BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION parking_revoke_sessions()');
  }
  async down(runner: QueryRunner) {
    await runner.query('DROP TRIGGER IF EXISTS parking_revoke_sessions ON users');
    await runner.query('DROP FUNCTION IF EXISTS parking_revoke_sessions()');
    await runner.query('ALTER TABLE users DROP COLUMN IF EXISTS "authVersion"');
  }
}
