import { MigrationInterface, QueryRunner } from 'typeorm';

// El reconocimiento de patentes deja de ser una key de la plataforma: cada playa que lo contrata
// tiene su propia cuenta de Plate Recognizer (su plan, su cupo) y el super admin carga el token
// acá. Una playa sin fila no tiene reconocimiento.
//
// - `token` va cifrado con token-crypto (la misma clave que los tokens de MercadoPago).
// - `huella` es el SHA-256 del token: deja ver que dos playas comparten la misma cuenta (y por lo
//   tanto el mismo cupo) sin tener que descifrar nada.
// - El operador lee desde la conexión con alcance (`parking_scoped`): solo SELECT y solo la fila de
//   su playa. Cargar o quitar el token es del super admin, que escribe con el rol dueño.
// - Sin entidad TypeORM a propósito: el borrado de playas cuenta como operación toda entidad con
//   `playaId`, y esto es configuración; se va con la playa por el ON DELETE CASCADE.
export class PlateRecognizerCuentas1790000026000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query(`CREATE TABLE IF NOT EXISTS plate_recognizer_cuentas (
      "playaId" uuid PRIMARY KEY REFERENCES playas(id) ON DELETE CASCADE,
      token text NOT NULL,
      huella varchar(64) NOT NULL,
      "terminaEn" varchar(4) NOT NULL,
      "cargadoPor" uuid REFERENCES users(id) ON DELETE SET NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await r.query('ALTER TABLE plate_recognizer_cuentas ENABLE ROW LEVEL SECURITY');
    await r.query('ALTER TABLE plate_recognizer_cuentas FORCE ROW LEVEL SECURITY');
    const [owner] = await r.query('SELECT current_user AS name');
    await r.query('DROP POLICY IF EXISTS parking_system ON plate_recognizer_cuentas');
    await r.query(
      `CREATE POLICY parking_system ON plate_recognizer_cuentas TO "${owner.name.replace(/"/g, '""')}" USING (true) WITH CHECK (true)`,
    );
    await r.query('DROP POLICY IF EXISTS parking_isolation ON plate_recognizer_cuentas');
    await r.query(
      `CREATE POLICY parking_isolation ON plate_recognizer_cuentas FOR SELECT TO parking_scoped USING ("playaId" = NULLIF(current_setting('parking.playa', true), '')::uuid)`,
    );
    await r.query('GRANT SELECT ON plate_recognizer_cuentas TO parking_scoped');
  }

  async down(r: QueryRunner) {
    await r.query('DROP TABLE IF EXISTS plate_recognizer_cuentas');
  }
}
