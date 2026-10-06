import { MigrationInterface, QueryRunner } from 'typeorm';

const quote = (s: string) => '"' + s.replace(/"/g, '""') + '"';

// QR que se paga desde cualquier banco o billetera (QR interoperable).
//
// 1. `mercadopago_cajas`: la sucursal y la caja de MercadoPago de cada playa, creadas en la cuenta
//    de la empresa. Sin caja, el cobro con QR sigue siendo el link de MercadoPago de siempre. Es de
//    la empresa (la crea su administrador para cualquiera de sus playas); el operador la lee para
//    cobrar. `playaId` se carga siempre a mano: la fila es de la playa que eligió el administrador,
//    no de la que tenga activa.
// 2. En `cobros_mercadopago`: la orden de MercadoPago y el código QR estándar (`qrData`) cuando el
//    cobro se generó con la caja de la playa.
export class QrInteroperable1790000031000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query(`CREATE TABLE IF NOT EXISTS mercadopago_cajas (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "empresaId" uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      "playaId" uuid NOT NULL REFERENCES playas(id) ON DELETE CASCADE,
      "mpUserId" varchar(64) NOT NULL,
      "storeId" varchar(64) NOT NULL,
      "externalStoreId" varchar(60) NOT NULL,
      "posId" varchar(64) NOT NULL,
      "externalPosId" varchar(60) NOT NULL,
      direccion jsonb,
      "creadaPor" uuid,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`);
    // Una caja por playa y cuenta: si la empresa conecta otra cuenta, la playa necesita otra caja.
    await r.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS mercadopago_cajas_playa ON mercadopago_cajas ("playaId", "mpUserId")',
    );

    const [identity] = await r.query('SELECT current_user AS name');
    const platform = `current_setting('parking.platform', true) = 'yes'`;
    const empresa = `"empresaId" = NULLIF(current_setting('parking.empresa', true), '')::uuid`;
    await r.query('ALTER TABLE mercadopago_cajas ENABLE ROW LEVEL SECURITY');
    await r.query('ALTER TABLE mercadopago_cajas FORCE ROW LEVEL SECURITY');
    await r.query('DROP POLICY IF EXISTS parking_system ON mercadopago_cajas');
    await r.query(
      'DROP POLICY IF EXISTS parking_isolation ON mercadopago_cajas',
    );
    await r.query(
      `CREATE POLICY parking_system ON mercadopago_cajas TO ${quote(identity.name)} USING (true) WITH CHECK (true)`,
    );
    await r.query(
      `CREATE POLICY parking_isolation ON mercadopago_cajas TO parking_scoped USING (${platform} OR (${empresa})) WITH CHECK (${platform} OR (${empresa}))`,
    );
    await r.query(
      'GRANT SELECT, INSERT, UPDATE ON mercadopago_cajas TO parking_scoped',
    );
    // Las FK de Postgres ignoran RLS: el trigger compartido revalida que la playa sea visible.
    await r.query(
      'DROP TRIGGER IF EXISTS parking_b_references ON mercadopago_cajas',
    );
    await r.query(
      'CREATE TRIGGER parking_b_references BEFORE INSERT OR UPDATE ON mercadopago_cajas FOR EACH ROW EXECUTE FUNCTION parking_check_references()',
    );

    await r.query(`ALTER TABLE cobros_mercadopago
      ADD COLUMN IF NOT EXISTS "ordenId" varchar(64),
      ADD COLUMN IF NOT EXISTS "qrData" text`);
  }

  async down(r: QueryRunner) {
    await r.query(`ALTER TABLE cobros_mercadopago
      DROP COLUMN IF EXISTS "ordenId",
      DROP COLUMN IF EXISTS "qrData"`);
    await r.query('DROP TABLE IF EXISTS mercadopago_cajas');
  }
}
