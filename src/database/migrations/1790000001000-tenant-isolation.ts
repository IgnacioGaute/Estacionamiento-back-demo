import { MigrationInterface, QueryRunner } from 'typeorm';

export const PLAYA_TABLES = ['customers', 'receipts', 'receipt_payments', 'payments_history_on_account', 'interest_settings', 'parking_types', 'vehicles', 'vehicle_renters', 'renter_parking_types', 'tickets', 'ticket_registrations', 'ticket_registration_for_days', 'tickets-price', 'ticket_price_brackets', 'ticket_schedule_settings', 'ticket_vehicle_types', 'box_lists', 'other_payments', 'turnos', 'movimientos', 'cash_entries', 'notes'];
const quote = (s: string) => '"' + s.replace(/"/g, '""') + '"';
export class TenantIsolation1790000001000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'parking_scoped') THEN CREATE ROLE parking_scoped NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
    const [identity] = await runner.query('SELECT current_user AS name');
    await runner.query(`GRANT parking_scoped TO ${quote(identity.name)}`);
    await runner.query('GRANT USAGE ON SCHEMA public TO parking_scoped');
    await runner.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO parking_scoped');
    for (const table of PLAYA_TABLES) {
      await runner.query(`ALTER TABLE ${quote(table)} ADD COLUMN IF NOT EXISTS "playaId" uuid REFERENCES playas(id)`);
      await runner.query(`CREATE INDEX IF NOT EXISTS ${quote('tenant_' + table)} ON ${quote(table)} ("playaId")`);
    }
    // Natural codes can repeat in different parking lots.
    await runner.query(`ALTER TABLE ticket_vehicle_types ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid()`);
    const keys = await runner.query(`SELECT conname FROM pg_constraint WHERE conrelid='ticket_vehicle_types'::regclass AND contype='p'`);
    for (const key of keys) await runner.query(`ALTER TABLE ticket_vehicle_types DROP CONSTRAINT ${quote(key.conname)}`);
    await runner.query('ALTER TABLE ticket_vehicle_types ADD PRIMARY KEY (id)');
    await runner.query('CREATE UNIQUE INDEX IF NOT EXISTS tenant_vehicle_code ON ticket_vehicle_types ("playaId", code)');

    await runner.query(`CREATE OR REPLACE FUNCTION parking_stamp_scope() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE p uuid := NULLIF(current_setting('parking.playa', true), '')::uuid;
              e uuid := NULLIF(current_setting('parking.empresa', true), '')::uuid;
      BEGIN
        IF current_user <> 'parking_scoped' OR current_setting('parking.platform', true) = 'yes' THEN RETURN NEW; END IF;
        IF TG_TABLE_NAME = 'users' THEN
          IF TG_OP = 'INSERT' AND NEW."empresaId" IS NULL THEN NEW."empresaId" := e; END IF;
        ELSE
          IF TG_OP = 'INSERT' AND NEW."playaId" IS NULL THEN NEW."playaId" := p; END IF;
        END IF;
        RETURN NEW;
      END $$`);

    // PostgreSQL's FK checks bypass RLS. Verify visible references as well, preventing a
    // user from attaching a foreign company's receipt, customer, ticket or cash box.
    await runner.query(`CREATE OR REPLACE FUNCTION parking_check_references() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE fk record; val text; visible boolean;
      BEGIN
        IF current_user <> 'parking_scoped' OR current_setting('parking.platform', true) = 'yes' THEN RETURN NEW; END IF;
        FOR fk IN
          SELECT a.attname AS local_col, rn.nspname AS ref_schema, rc.relname AS ref_table, ra.attname AS ref_col
          FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
          JOIN pg_class rc ON rc.oid=c.confrelid JOIN pg_namespace rn ON rn.oid=rc.relnamespace
          JOIN pg_attribute ra ON ra.attrelid=c.confrelid AND ra.attnum=c.confkey[1]
          WHERE c.conrelid=TG_RELID AND c.contype='f' AND array_length(c.conkey,1)=1
        LOOP
          IF TG_OP = 'UPDATE' AND (to_jsonb(NEW)->>fk.local_col) IS NOT DISTINCT FROM (to_jsonb(OLD)->>fk.local_col) THEN CONTINUE; END IF;
          val := to_jsonb(NEW)->>fk.local_col;
          IF val IS NOT NULL THEN
            EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.%I WHERE %I::text=$1)', fk.ref_schema, fk.ref_table, fk.ref_col) INTO visible USING val;
            IF NOT visible THEN RAISE EXCEPTION 'Referencia fuera de la empresa o playa permitida' USING ERRCODE='42501'; END IF;
          END IF;
        END LOOP;
        RETURN NEW;
      END $$`);
    const platform = `current_setting('parking.platform', true) = 'yes'`;
    for (const table of [...PLAYA_TABLES, 'users', 'empresas', 'playas', 'usuario_playas']) {
      const scope = table === 'empresas' ? `id = NULLIF(current_setting('parking.empresa', true), '')::uuid`
        : ['users', 'playas'].includes(table) ? `"empresaId" = NULLIF(current_setting('parking.empresa', true), '')::uuid`
        : `"playaId" = NULLIF(current_setting('parking.playa', true), '')::uuid`;
      const check = table === 'users' ? `(${scope} AND role <> 'SUPER_ADMIN')` : scope;
      await runner.query(`ALTER TABLE ${quote(table)} ENABLE ROW LEVEL SECURITY`);
      await runner.query(`ALTER TABLE ${quote(table)} FORCE ROW LEVEL SECURITY`);
      await runner.query(`DROP POLICY IF EXISTS parking_isolation ON ${quote(table)}`);
      await runner.query(`DROP POLICY IF EXISTS parking_system ON ${quote(table)}`);
      await runner.query(`CREATE POLICY parking_system ON ${quote(table)} TO ${quote(identity.name)} USING (true) WITH CHECK (true)`);
      await runner.query(`CREATE POLICY parking_isolation ON ${quote(table)} TO parking_scoped USING (${platform} OR (${scope})) WITH CHECK (${platform} OR (${check}))`);
      await runner.query(`GRANT SELECT ON ${quote(table)} TO parking_scoped`);
      if (PLAYA_TABLES.includes(table) || table === 'users' || table === 'usuario_playas') {
        await runner.query(`GRANT INSERT, UPDATE, DELETE ON ${quote(table)} TO parking_scoped`);
        await runner.query(`CREATE OR REPLACE TRIGGER parking_a_stamp BEFORE INSERT OR UPDATE ON ${quote(table)} FOR EACH ROW EXECUTE FUNCTION parking_stamp_scope()`);
        await runner.query(`CREATE OR REPLACE TRIGGER parking_b_references BEFORE INSERT OR UPDATE ON ${quote(table)} FOR EACH ROW EXECUTE FUNCTION parking_check_references()`);
      }
    }
    // These legacy IDs are plain columns, not ORM relations.
    for (const [table, column, target] of [['cash_entries','boxId','box_lists'], ['cash_entries','turnoId','turnos']]) {
      const name = 'tenant_fk_' + table + '_' + column;
      await runner.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${name}') THEN ALTER TABLE ${quote(table)} ADD CONSTRAINT ${quote(name)} FOREIGN KEY (${quote(column)}) REFERENCES ${quote(target)}(id) NOT VALID; END IF; END $$`);
    }
  }
  async down() { throw new Error('Tenant isolation requires an explicit data-preserving rollback.'); }
}
