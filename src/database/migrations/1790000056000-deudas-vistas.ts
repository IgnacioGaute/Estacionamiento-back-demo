import { MigrationInterface, QueryRunner } from 'typeorm';

// Qué deudas de inquilinos ya vio cada persona en Avisos → Inquilinos. El número rojo del menú
// cuenta las que no vio; al abrir la pestaña se marcan solas. Una deuda vuelve a ser nueva si
// cambia: otro atraso después de pagar (otro vencidoDesde) o si pasa de 30 o de 60 días (tramo).
// usuarioId no tiene clave foránea: el super admin no es visible desde la empresa y la revisión de
// referencias lo rechazaría (igual que notes.readBy, que guarda ids sueltos).
export class DeudasVistas1790000056000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query(`CREATE TABLE IF NOT EXISTS deudas_vistas (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "playaId" uuid, "usuarioId" uuid NOT NULL,
      "customerId" uuid NOT NULL, "vencidoDesde" date NOT NULL, tramo varchar(20) NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now())`);
    for (const [column, target, extra] of [['playaId', 'playas', ''], ['customerId', 'customers', ' ON DELETE CASCADE']]) {
      const name = `deudas_vistas_${column}`;
      await r.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${name}') THEN
        ALTER TABLE deudas_vistas ADD CONSTRAINT "${name}" FOREIGN KEY ("${column}") REFERENCES ${target}(id)${extra};
      END IF; END $$`);
    }
    await r.query('CREATE UNIQUE INDEX IF NOT EXISTS deudas_vistas_unica ON deudas_vistas ("usuarioId", "customerId", "vencidoDesde", tramo)');
    await r.query('CREATE INDEX IF NOT EXISTS deudas_vistas_playa ON deudas_vistas ("playaId")');
    await r.query('ALTER TABLE deudas_vistas ENABLE ROW LEVEL SECURITY');
    await r.query('ALTER TABLE deudas_vistas FORCE ROW LEVEL SECURITY');
    const [owner] = await r.query('SELECT current_user AS name');
    const identity = owner.name.replace(/"/g, '""');
    await r.query('DROP POLICY IF EXISTS parking_system ON deudas_vistas');
    await r.query('CREATE POLICY parking_system ON deudas_vistas TO "' + identity + '" USING (true) WITH CHECK (true)');
    const [role] = await r.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='parking_scoped') AS present");
    if (role.present) {
      const scope = `current_setting('parking.platform', true) = 'yes' OR "playaId" = NULLIF(current_setting('parking.playa', true), '')::uuid`;
      await r.query('DROP POLICY IF EXISTS parking_isolation ON deudas_vistas');
      await r.query(`CREATE POLICY parking_isolation ON deudas_vistas TO parking_scoped USING (${scope}) WITH CHECK (${scope})`);
      // Ver no se deshace: solo se lee y se agrega.
      await r.query('GRANT SELECT, INSERT ON deudas_vistas TO parking_scoped');
      await r.query('CREATE OR REPLACE TRIGGER parking_a_stamp BEFORE INSERT OR UPDATE ON deudas_vistas FOR EACH ROW EXECUTE FUNCTION parking_stamp_scope()');
      await r.query('CREATE OR REPLACE TRIGGER parking_b_references BEFORE INSERT OR UPDATE ON deudas_vistas FOR EACH ROW EXECUTE FUNCTION parking_check_references()');
    }
  }

  async down(r: QueryRunner) {
    await r.query('DROP TABLE IF EXISTS deudas_vistas');
  }
}
