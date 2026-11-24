import { MigrationInterface, QueryRunner } from 'typeorm';

// Correcciones de registros: el operador se equivocó al registrar una salida (patente, medio de
// pago, lo que dijo recibir, el vehículo) y la corrige sin volver a cargar la operación. Cada
// corrección guarda la operación original, quién y cuándo, el motivo, los valores anteriores y
// nuevos, el estado (aplicada, pendiente de revisión o rechazada) y los ajustes y la evidencia que
// la respaldan. Nada se borra: los cambios de dinero son movimientos nuevos vinculados
// (`movimientos.correccionId`), y el registro original queda en `antes`.
//
// usuarioId y revisadoPor no tienen clave foránea: el super admin no es visible desde la empresa y
// la revisión de referencias lo rechazaría (igual que deudas_vistas y notes.readBy).
export class Correcciones1790000058000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query(`CREATE TABLE IF NOT EXISTS correcciones (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "playaId" uuid, "solicitudId" uuid NOT NULL,
      tipo varchar(30) NOT NULL, estado varchar(20) NOT NULL, "registrationId" uuid, "paseId" uuid,
      "movimientoId" uuid, "destinoRegistrationId" uuid, "turnoId" uuid, "imputadaTurnoId" uuid,
      "posteriorAlCierre" boolean NOT NULL DEFAULT false,
      "usuarioId" uuid NOT NULL, "usuarioNombre" varchar(255), motivo varchar(40) NOT NULL, detalle text,
      antes jsonb NOT NULL DEFAULT '{}', despues jsonb NOT NULL DEFAULT '{}', efecto jsonb NOT NULL DEFAULT '{}',
      evidencia jsonb, "revisadoPor" uuid, "revisadoPorNombre" varchar(255), "revisadoEl" timestamptz, resolucion text,
      "aplicadaEl" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now())`);
    for (const [column, target] of [['playaId', 'playas'], ['registrationId', 'ticket_registrations'], ['paseId', 'ticket_registration_for_days'],
      ['movimientoId', 'movimientos'], ['destinoRegistrationId', 'ticket_registrations'], ['turnoId', 'turnos'], ['imputadaTurnoId', 'turnos']]) {
      const name = `correcciones_${column}`;
      await r.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${name}') THEN
        ALTER TABLE correcciones ADD CONSTRAINT "${name}" FOREIGN KEY ("${column}") REFERENCES ${target}(id);
      END IF; END $$`);
    }
    // Un doble toque, un reintento o una respuesta perdida mandan la misma solicitud: una sola fila.
    await r.query('CREATE UNIQUE INDEX IF NOT EXISTS correcciones_solicitud ON correcciones ("solicitudId")');
    await r.query('CREATE INDEX IF NOT EXISTS correcciones_playa ON correcciones ("playaId")');
    await r.query('CREATE INDEX IF NOT EXISTS correcciones_registration ON correcciones ("registrationId")');
    await r.query('CREATE INDEX IF NOT EXISTS correcciones_pase ON correcciones ("paseId")');
    await r.query('CREATE INDEX IF NOT EXISTS correcciones_estado ON correcciones (estado, "createdAt")');
    // Los ajustes que generó cada corrección.
    await r.query('ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS "correccionId" uuid');
    await r.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='movimientos_correccion') THEN
      ALTER TABLE movimientos ADD CONSTRAINT movimientos_correccion FOREIGN KEY ("correccionId") REFERENCES correcciones(id);
    END IF; END $$`);
    await r.query('CREATE INDEX IF NOT EXISTS movimientos_correccion_idx ON movimientos ("correccionId")');

    await r.query('ALTER TABLE correcciones ENABLE ROW LEVEL SECURITY');
    await r.query('ALTER TABLE correcciones FORCE ROW LEVEL SECURITY');
    const [owner] = await r.query('SELECT current_user AS name');
    const identity = owner.name.replace(/"/g, '""');
    await r.query('DROP POLICY IF EXISTS parking_system ON correcciones');
    await r.query('CREATE POLICY parking_system ON correcciones TO "' + identity + '" USING (true) WITH CHECK (true)');
    const [role] = await r.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='parking_scoped') AS present");
    if (role.present) {
      const scope = `current_setting('parking.platform', true) = 'yes' OR "playaId" = NULLIF(current_setting('parking.playa', true), '')::uuid`;
      await r.query('DROP POLICY IF EXISTS parking_isolation ON correcciones');
      await r.query(`CREATE POLICY parking_isolation ON correcciones TO parking_scoped USING (${scope}) WITH CHECK (${scope})`);
      // Se agrega y se resuelve (estado, revisión); nunca se borra.
      await r.query('GRANT SELECT, INSERT, UPDATE ON correcciones TO parking_scoped');
      await r.query('CREATE OR REPLACE TRIGGER parking_a_stamp BEFORE INSERT OR UPDATE ON correcciones FOR EACH ROW EXECUTE FUNCTION parking_stamp_scope()');
      await r.query('CREATE OR REPLACE TRIGGER parking_b_references BEFORE INSERT OR UPDATE ON correcciones FOR EACH ROW EXECUTE FUNCTION parking_check_references()');
    }
  }

  async down() { throw new Error('Se conservan las correcciones y sus vínculos.'); }
}
