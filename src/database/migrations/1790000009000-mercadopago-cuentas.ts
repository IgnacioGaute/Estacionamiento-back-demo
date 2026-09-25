import { MigrationInterface, QueryRunner } from 'typeorm';

const quote = (s: string) => '"' + s.replace(/"/g, '""') + '"';

// Dónde se guarda la cuenta de MercadoPago con la que cobra cada empresa.
//
// Va aislada por empresa, como audit_log y no como las tablas de PLAYA_TABLES: la conexión es de
// la empresa, no de una playa (ver el comentario de la entidad). El rol `parking_scoped` —con el
// que corre toda ruta operativa— solo ve y escribe las filas de su propia empresa.
//
// Los GRANT son los tres que la operación necesita y ni uno más:
//   SELECT  para poder cobrar,
//   INSERT  para conectar la cuenta,
//   UPDATE  para renovar el token y para desconectar.
// DELETE queda afuera a propósito: desconectar borra los tokens y marca la fila, no la elimina,
// así queda el rastro de que esa empresa alguna vez estuvo conectada y quién la conectó.
//
// El grant de UPDATE es el que hay que mirar si algo no anda: parking_receipts se creó con
// SELECT e INSERT solamente, y una tabla con estado mutable creada así nunca podría cambiarlo.
export class MercadoPagoCuentas1790000009000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`
      CREATE TABLE IF NOT EXISTS mercadopago_cuentas (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "empresaId" uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
        "mpUserId" varchar(64) NOT NULL,
        nickname varchar(255),
        email varchar(255),
        "accessToken" text NOT NULL,
        "refreshToken" text NOT NULL,
        "expiraEl" timestamptz NOT NULL,
        estado varchar(20) NOT NULL DEFAULT 'ACTIVA',
        "ultimoError" varchar(255),
        "conectadaPor" uuid,
        "conectadaEl" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Una cuenta por empresa: conectar de nuevo pisa la que estaba, no agrega una segunda.
    await runner.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS mercadopago_cuentas_empresa ON mercadopago_cuentas ("empresaId")',
    );

    const [identity] = await runner.query('SELECT current_user AS name');
    const platform = `current_setting('parking.platform', true) = 'yes'`;
    const scope = `"empresaId" = NULLIF(current_setting('parking.empresa', true), '')::uuid`;

    await runner.query('ALTER TABLE mercadopago_cuentas ENABLE ROW LEVEL SECURITY');
    await runner.query('ALTER TABLE mercadopago_cuentas FORCE ROW LEVEL SECURITY');
    await runner.query('DROP POLICY IF EXISTS parking_isolation ON mercadopago_cuentas');
    await runner.query('DROP POLICY IF EXISTS parking_system ON mercadopago_cuentas');
    await runner.query(
      `CREATE POLICY parking_system ON mercadopago_cuentas TO ${quote(identity.name)} USING (true) WITH CHECK (true)`,
    );
    await runner.query(
      `CREATE POLICY parking_isolation ON mercadopago_cuentas TO parking_scoped USING (${platform} OR (${scope})) WITH CHECK (${platform} OR (${scope}))`,
    );
    await runner.query(
      'GRANT SELECT, INSERT, UPDATE ON mercadopago_cuentas TO parking_scoped',
    );

    // Postgres no chequea las FK contra RLS, así que el trigger compartido revalida que la empresa
    // referenciada sea una que el que inserta puede ver.
    await runner.query(
      'DROP TRIGGER IF EXISTS parking_b_references ON mercadopago_cuentas',
    );
    await runner.query(
      'CREATE TRIGGER parking_b_references BEFORE INSERT OR UPDATE ON mercadopago_cuentas FOR EACH ROW EXECUTE FUNCTION parking_check_references()',
    );
  }

  async down(runner: QueryRunner) {
    await runner.query('DROP TABLE IF EXISTS mercadopago_cuentas');
  }
}
