import { MigrationInterface, QueryRunner } from 'typeorm';
export class TurnosDiarios1790000036000 implements MigrationInterface {
  async up(r: QueryRunner) {
    const columns: Record<string, string[]> = {
      turnos: ['"cierreAutomatico" boolean NOT NULL DEFAULT false', '"continuacionDeId" uuid', '"jornadaId" uuid', '"fechaOperativa" date', '"sueldoPrevisto" int NOT NULL DEFAULT 0', '"sueldoRetirado" int NOT NULL DEFAULT 0', '"alertaSueldo" text', '"vehiculosInicio" int', '"vehiculosFin" int', '"saldoAlCorte" int', '"salidasRegistradas" int'],
      cash_registers: ['"fondoObjetivo" int NOT NULL DEFAULT 15000'],
      cash_entries: ["categoria varchar NOT NULL DEFAULT 'COBRO'"],
      cash_session_movements: ['"turnoId" uuid'],
      ticket_schedule_settings: ['"sueldoAutomatico" boolean NOT NULL DEFAULT false', '"sueldoPorTurno" int NOT NULL DEFAULT 0'],
      ticket_registrations: ['"exitTurnoId" uuid'],
      ticket_registration_for_days: ['"exitTurnoId" uuid'],
    };
    for (const [table, fields] of Object.entries(columns)) for (const field of fields)
      await r.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${field}`);
    await r.query(`CREATE UNIQUE INDEX IF NOT EXISTS turno_continuacion_unica ON turnos ("continuacionDeId") WHERE "continuacionDeId" IS NOT NULL`);
    await r.query(`CREATE INDEX IF NOT EXISTS turno_fecha_operativa ON turnos ("playaId", "fechaOperativa")`);
    await r.query(`CREATE TABLE IF NOT EXISTS turno_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "playaId" uuid,
      "turnoId" uuid, medio varchar NOT NULL, amount int NOT NULL,
      referencia varchar NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now())`);
    // También sobre un esquema inicial creado por synchronize, que ya trae la tabla.
    for (const [table, column, target] of [['turnos', 'continuacionDeId', 'turnos'], ['turnos', 'jornadaId', 'turnos'],
      ['cash_session_movements', 'turnoId', 'turnos'], ['ticket_registrations', 'exitTurnoId', 'turnos'],
      ['ticket_registration_for_days', 'exitTurnoId', 'turnos'], ['turno_payments', 'turnoId', 'turnos'], ['turno_payments', 'playaId', 'playas']]) {
      const name = `daily_${table}_${column}`;
      await r.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${name}') THEN
        ALTER TABLE ${table} ADD CONSTRAINT "${name}" FOREIGN KEY ("${column}") REFERENCES ${target}(id) NOT VALID;
      END IF; END $$`);
    }
    await r.query('CREATE INDEX IF NOT EXISTS turno_payments_turno ON turno_payments ("turnoId")');
    await r.query('ALTER TABLE turno_payments ENABLE ROW LEVEL SECURITY');
    await r.query('ALTER TABLE turno_payments FORCE ROW LEVEL SECURITY');
    const [owner] = await r.query('SELECT current_user AS name');
    const identity = owner.name.replace(/"/g, '""');
    await r.query('DROP POLICY IF EXISTS parking_system ON turno_payments');
    await r.query('CREATE POLICY parking_system ON turno_payments TO "' + identity + '" USING (true) WITH CHECK (true)');
    const [role] = await r.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='parking_scoped') AS present");
    if (role.present) {
      await r.query('DROP POLICY IF EXISTS parking_isolation ON turno_payments');
      await r.query(`CREATE POLICY parking_isolation ON turno_payments TO parking_scoped
        USING ("playaId" = NULLIF(current_setting('parking.playa', true), '')::uuid)
        WITH CHECK ("playaId" = NULLIF(current_setting('parking.playa', true), '')::uuid)`);
      await r.query('GRANT SELECT, INSERT ON turno_payments TO parking_scoped');
      await r.query('CREATE OR REPLACE TRIGGER parking_a_stamp BEFORE INSERT OR UPDATE ON turno_payments FOR EACH ROW EXECUTE FUNCTION parking_stamp_scope()');
      await r.query('CREATE OR REPLACE TRIGGER parking_b_references BEFORE INSERT OR UPDATE ON turno_payments FOR EACH ROW EXECUTE FUNCTION parking_check_references()');
    }
  }
  async down() { throw new Error('Se conservan los cortes diarios y los retiros de sueldo.'); }
}
