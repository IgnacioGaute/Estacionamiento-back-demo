import { MigrationInterface, QueryRunner } from 'typeorm';

const quote = (s: string) => '"' + s.replace(/"/g, '""') + '"';

// El cobro con QR: un pedido de pago por estadía, con su importe congelado.
//
// Dos cosas que hace esta migración:
//
// 1. Suma MERCADOPAGO a los medios de pago. `metodo` es un enum de Postgres de verdad, no un
//    varchar. Desde PostgreSQL 12 se puede agregar un valor dentro de una transacción siempre que
//    no se lo USE en la misma transacción — acá sólo se agrega, así que la migración corre normal.
//
// 2. Crea cobros_mercadopago, aislada por playa como el resto de la operación.
//
// Sobre los permisos: SELECT, INSERT y UPDATE. UPDATE es imprescindible porque el estado del
// cobro cambia (PENDIENTE -> ACREDITADO). DELETE queda afuera: un pedido de pago no se borra, se
// cancela o se vence, y así queda el rastro de lo que se intentó cobrar.
export class CobrosMercadoPago1790000011000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(
      `ALTER TYPE movimientos_metodo_enum ADD VALUE IF NOT EXISTS 'MERCADOPAGO'`,
    );

    await runner.query(`
      CREATE TABLE IF NOT EXISTS cobros_mercadopago (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "playaId" uuid NOT NULL REFERENCES playas(id),
        "registrationId" uuid NOT NULL REFERENCES ticket_registrations(id) ON DELETE CASCADE,
        monto int NOT NULL,
        estado varchar(20) NOT NULL DEFAULT 'PENDIENTE',
        "preferenceId" varchar(64) NOT NULL,
        "initPoint" text NOT NULL,
        "mpPaymentId" varchar(64),
        "expiraEl" timestamptz NOT NULL,
        "acreditadoEl" timestamptz,
        "creadoPor" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await runner.query(
      'CREATE INDEX IF NOT EXISTS tenant_cobros_mercadopago ON cobros_mercadopago ("playaId")',
    );
    await runner.query(
      'CREATE INDEX IF NOT EXISTS cobros_mercadopago_registro ON cobros_mercadopago ("registrationId")',
    );
    // La idempotencia del cobro vive acá: MercadoPago puede avisar del mismo pago más de una vez
    // —dos consultas simultáneas, un reintento— y sin este índice cada aviso generaría un
    // movimiento nuevo y la estadía quedaría cobrada dos veces.
    await runner.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS cobros_mercadopago_pago ON cobros_mercadopago ("mpPaymentId") WHERE "mpPaymentId" IS NOT NULL',
    );

    const [identity] = await runner.query('SELECT current_user AS name');
    const platform = `current_setting('parking.platform', true) = 'yes'`;
    const scope = `"playaId" = NULLIF(current_setting('parking.playa', true), '')::uuid`;

    await runner.query('ALTER TABLE cobros_mercadopago ENABLE ROW LEVEL SECURITY');
    await runner.query('ALTER TABLE cobros_mercadopago FORCE ROW LEVEL SECURITY');
    await runner.query('DROP POLICY IF EXISTS parking_isolation ON cobros_mercadopago');
    await runner.query('DROP POLICY IF EXISTS parking_system ON cobros_mercadopago');
    await runner.query(
      `CREATE POLICY parking_system ON cobros_mercadopago TO ${quote(identity.name)} USING (true) WITH CHECK (true)`,
    );
    await runner.query(
      `CREATE POLICY parking_isolation ON cobros_mercadopago TO parking_scoped USING (${platform} OR (${scope})) WITH CHECK (${platform} OR (${scope}))`,
    );
    await runner.query(
      'GRANT SELECT, INSERT, UPDATE ON cobros_mercadopago TO parking_scoped',
    );

    // Los dos triggers compartidos, en el mismo orden que el resto de las tablas de playa:
    // primero se estampa la playa (parking_a_stamp), después se validan las referencias contra
    // las filas visibles (parking_b_references), porque las FK de Postgres ignoran RLS.
    await runner.query('DROP TRIGGER IF EXISTS parking_a_stamp ON cobros_mercadopago');
    await runner.query(
      'CREATE TRIGGER parking_a_stamp BEFORE INSERT OR UPDATE ON cobros_mercadopago FOR EACH ROW EXECUTE FUNCTION parking_stamp_scope()',
    );
    await runner.query('DROP TRIGGER IF EXISTS parking_b_references ON cobros_mercadopago');
    await runner.query(
      'CREATE TRIGGER parking_b_references BEFORE INSERT OR UPDATE ON cobros_mercadopago FOR EACH ROW EXECUTE FUNCTION parking_check_references()',
    );
  }

  async down(runner: QueryRunner) {
    // El valor del enum no se saca: quitar un valor de un enum en Postgres obliga a recrear el
    // tipo, y si ya hay movimientos cobrados con MERCADOPAGO no habría dónde ponerlos.
    await runner.query('DROP TABLE IF EXISTS cobros_mercadopago');
  }
}
