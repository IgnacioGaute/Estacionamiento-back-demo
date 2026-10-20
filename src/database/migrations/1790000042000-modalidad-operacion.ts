import { MigrationInterface, QueryRunner } from 'typeorm';

// Modalidad de operación por playa (Con cobro / Gratuito) y la de cada estadía al ingresar.
// El valor por omisión es constante: las playas y estadías existentes quedan «Con cobro» sin
// reescribir filas, snapshots ni movimientos. Solo la conexión de plataforma escribe `playas`
// (parking_scoped tiene SELECT), así que solo el super admin puede cambiar la modalidad.
export class ModalidadOperacion1790000042000 implements MigrationInterface {
  async up(r: QueryRunner) {
    for (const table of ['playas', 'ticket_registrations']) {
      await r.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS modalidad varchar(20) NOT NULL DEFAULT 'CON_COBRO'`);
      await r.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${table}_modalidad_valida') THEN
          ALTER TABLE ${table} ADD CONSTRAINT ${table}_modalidad_valida CHECK (modalidad IN ('CON_COBRO', 'GRATUITO'));
        END IF;
      END $$`);
    }
    // La modalidad de una estadía es la de su ingreso y no cambia: así ninguna actualización (un
    // merge genérico, un endpoint futuro) puede convertir una estadía con cobro en gratuita para
    // sacarla sin pagar. parking_scoped tiene UPDATE sobre la tabla; esto lo cubre en la base.
    await r.query(`CREATE OR REPLACE FUNCTION parking_modalidad_inmutable() RETURNS trigger AS $$
      BEGIN
        IF NEW.modalidad IS DISTINCT FROM OLD.modalidad THEN
          RAISE EXCEPTION 'La modalidad de una estadía no se puede cambiar después del ingreso.';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await r.query('DROP TRIGGER IF EXISTS parking_modalidad_inmutable ON ticket_registrations');
    await r.query(`CREATE TRIGGER parking_modalidad_inmutable BEFORE UPDATE OF modalidad ON ticket_registrations
      FOR EACH ROW EXECUTE FUNCTION parking_modalidad_inmutable()`);
  }

  async down() { throw new Error('Se conserva la modalidad de playas y estadías.'); }
}
