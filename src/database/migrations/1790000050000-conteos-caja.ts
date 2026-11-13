import { MigrationInterface, QueryRunner } from 'typeorm';

// Conteos de relevo en cajas compartidas y el primer conteo del arqueo final. Faltantes de caja
// que no se podían ubicar: entre relevos nadie contaba, y el arqueo guardaba solo el último
// importe aunque el operador lo hubiera cambiado después de ver lo que esperaba el sistema.
export class ConteosCaja1790000050000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query('ALTER TABLE turnos ADD COLUMN IF NOT EXISTS "primerConteo" int');
    await r.query('ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS "primerConteo" int');
    await r.query(`CREATE TABLE IF NOT EXISTS cash_session_counts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "playaId" uuid, "sesionId" uuid NOT NULL,
      "turnoId" uuid, "usuarioId" uuid NOT NULL, momento varchar NOT NULL, contado int NOT NULL,
      esperado int NOT NULL, diferencia int NOT NULL, motivo text,
      "createdAt" timestamptz NOT NULL DEFAULT now())`);
    for (const [column, target] of [['playaId', 'playas'], ['sesionId', 'cash_sessions'], ['turnoId', 'turnos'], ['usuarioId', 'users']]) {
      const name = `conteos_${column}`;
      await r.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${name}') THEN
        ALTER TABLE cash_session_counts ADD CONSTRAINT "${name}" FOREIGN KEY ("${column}") REFERENCES ${target}(id);
      END IF; END $$`);
    }
    await r.query('CREATE INDEX IF NOT EXISTS cash_session_counts_sesion ON cash_session_counts ("sesionId")');
    await r.query('CREATE INDEX IF NOT EXISTS cash_session_counts_playa ON cash_session_counts ("playaId")');
    await r.query('ALTER TABLE cash_session_counts ENABLE ROW LEVEL SECURITY');
    await r.query('ALTER TABLE cash_session_counts FORCE ROW LEVEL SECURITY');
    const [owner] = await r.query('SELECT current_user AS name');
    const identity = owner.name.replace(/"/g, '""');
    await r.query('DROP POLICY IF EXISTS parking_system ON cash_session_counts');
    await r.query('CREATE POLICY parking_system ON cash_session_counts TO "' + identity + '" USING (true) WITH CHECK (true)');
    const [role] = await r.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='parking_scoped') AS present");
    if (role.present) {
      const scope = `current_setting('parking.platform', true) = 'yes' OR "playaId" = NULLIF(current_setting('parking.playa', true), '')::uuid`;
      await r.query('DROP POLICY IF EXISTS parking_isolation ON cash_session_counts');
      await r.query(`CREATE POLICY parking_isolation ON cash_session_counts TO parking_scoped USING (${scope}) WITH CHECK (${scope})`);
      // Un conteo no se corrige ni se borra: es el registro de lo que había en ese momento.
      await r.query('GRANT SELECT, INSERT ON cash_session_counts TO parking_scoped');
      await r.query('CREATE OR REPLACE TRIGGER parking_a_stamp BEFORE INSERT OR UPDATE ON cash_session_counts FOR EACH ROW EXECUTE FUNCTION parking_stamp_scope()');
      await r.query('CREATE OR REPLACE TRIGGER parking_b_references BEFORE INSERT OR UPDATE ON cash_session_counts FOR EACH ROW EXECUTE FUNCTION parking_check_references()');
    }
  }

  async down() { throw new Error('Se conservan los conteos de caja.'); }
}
