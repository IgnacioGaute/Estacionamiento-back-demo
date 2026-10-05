import { MigrationInterface, QueryRunner } from 'typeorm';

export class CajasCompartidas1790000028000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query('ALTER TABLE ticket_schedule_settings ADD COLUMN IF NOT EXISTS "multipleShiftsEnabled" boolean NOT NULL DEFAULT false');
    await r.query(`CREATE TABLE IF NOT EXISTS cash_registers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "playaId" uuid REFERENCES playas(id), nombre varchar(80) NOT NULL,
      activa boolean NOT NULL DEFAULT true, principal boolean NOT NULL DEFAULT false, "createdAt" timestamptz NOT NULL DEFAULT now())`);
    await r.query(`CREATE TABLE IF NOT EXISTS cash_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "playaId" uuid REFERENCES playas(id), "cajaId" uuid NOT NULL REFERENCES cash_registers(id),
      estado varchar NOT NULL DEFAULT 'ABIERTO', "fechaApertura" timestamptz NOT NULL DEFAULT now(), "fechaCierre" timestamptz,
      "fondoInicial" int NOT NULL, "fondoEsperado" int NOT NULL DEFAULT 0, "cambioAgregado" int NOT NULL DEFAULT 0,
      "diferenciaApertura" int NOT NULL DEFAULT 0, "motivoApertura" text, "sesionAnteriorId" uuid UNIQUE,
      "efectivoTeorico" int, "efectivoContado" int, "efectivoParaSiguiente" int, "efectivoRetirado" int,
      diferencia int, observaciones text, "usuarioCierreId" uuid)`);
    await r.query(`CREATE TABLE IF NOT EXISTS cash_session_movements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "playaId" uuid REFERENCES playas(id), "sesionId" uuid NOT NULL REFERENCES cash_sessions(id),
      "usuarioId" uuid NOT NULL REFERENCES users(id), amount int NOT NULL, tipo varchar NOT NULL, motivo varchar(255) NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now())`);
    await r.query(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS "cajaId" uuid REFERENCES cash_registers(id),
      ADD COLUMN IF NOT EXISTS "cashSessionId" uuid REFERENCES cash_sessions(id), ADD COLUMN IF NOT EXISTS "cierreCaja" boolean NOT NULL DEFAULT false`);
    await r.query("CREATE UNIQUE INDEX IF NOT EXISTS cash_session_abierta ON cash_sessions (\"cajaId\") WHERE estado = 'ABIERTO'");
    await r.query('CREATE UNIQUE INDEX IF NOT EXISTS cash_register_principal ON cash_registers ("playaId") WHERE principal');
    await r.query('CREATE INDEX IF NOT EXISTS turnos_cash_session ON turnos ("cashSessionId")');
    await r.query(`INSERT INTO cash_registers ("playaId", nombre, principal) SELECT p.id, 'Caja principal', true FROM playas p
      WHERE NOT EXISTS (SELECT 1 FROM cash_registers c WHERE c."playaId" = p.id AND c.principal)`);
    // Las tablas nuevas mantienen el mismo aislamiento que tickets y turnos.
    const [role] = await r.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'parking_scoped') AS present");
    const [owner] = await r.query('SELECT current_user AS name');
    const identity = owner.name.replace(/"/g, '""');
    for (const table of ['cash_registers', 'cash_sessions', 'cash_session_movements']) {
      await r.query('ALTER TABLE ' + table + ' ENABLE ROW LEVEL SECURITY');
      await r.query('ALTER TABLE ' + table + ' FORCE ROW LEVEL SECURITY');
      await r.query('DROP POLICY IF EXISTS parking_system ON ' + table);
      await r.query('CREATE POLICY parking_system ON ' + table + ' TO "' + identity + '" USING (true) WITH CHECK (true)');
      if (role.present) {
        await r.query('DROP POLICY IF EXISTS parking_isolation ON ' + table);
        await r.query(`CREATE POLICY parking_isolation ON ${table} TO parking_scoped
          USING ("playaId" = NULLIF(current_setting('parking.playa', true), '')::uuid)
          WITH CHECK ("playaId" = NULLIF(current_setting('parking.playa', true), '')::uuid)`);
        await r.query('GRANT SELECT, INSERT, UPDATE ON ' + table + ' TO parking_scoped');
        const [functions] = await r.query("SELECT to_regprocedure('parking_stamp_scope()') IS NOT NULL AS present");
        if (functions.present) {
          await r.query('CREATE OR REPLACE TRIGGER parking_a_stamp BEFORE INSERT OR UPDATE ON ' + table + ' FOR EACH ROW EXECUTE FUNCTION parking_stamp_scope()');
          await r.query('CREATE OR REPLACE TRIGGER parking_b_references BEFORE INSERT OR UPDATE ON ' + table + ' FOR EACH ROW EXECUTE FUNCTION parking_check_references()');
        }
      }
    }
  }
  async down() { throw new Error('Las sesiones de caja y sus arqueos deben conservarse.'); }
}
