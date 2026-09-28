import { MigrationInterface, QueryRunner } from 'typeorm';

// Cuenta corriente de inquilinos y secciones habilitables por playa.
//
// 1. `playas.modulos`: qué secciones opcionales tiene prendidas cada playa. Lo decide el super
//    admin; arranca todo apagado, así que ninguna playa cambia al aplicar esta migración.
// 2. `receipts.concepto`: qué cobra el recibo («Abono octubre 2026», «Saldo inicial», «Recargo»).
//    Antes todo recibo era la cuota del mes y no hacía falta decirlo.
// 3. `receipt_payments.cuentaMovimientoId`: de qué asiento sale cada imputación, para poder
//    deshacer exactamente las de un pago cuando se anula.
// 4. `cuenta_movimientos`: el libro. Cada hecho de plata del inquilino es una fila nueva —saldo
//    inicial, cargo, pago, ajuste, anulación— y el saldo es la suma. El rol con alcance sólo puede
//    leer e insertar: ni la app puede corregir una fila, se corrige con otra.
export class CuentaCorrienteInquilinos1790000015000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query(`ALTER TABLE playas ADD COLUMN IF NOT EXISTS modulos jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await r.query('ALTER TABLE receipts ADD COLUMN IF NOT EXISTS concepto varchar(160)');
    await r.query('ALTER TABLE receipt_payments ADD COLUMN IF NOT EXISTS "cuentaMovimientoId" uuid');
    await r.query(
      'CREATE INDEX IF NOT EXISTS receipt_payments_cuenta_movimiento ON receipt_payments ("cuentaMovimientoId")',
    );

    await r.query(`CREATE TABLE IF NOT EXISTS cuenta_movimientos (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "playaId" uuid NOT NULL REFERENCES playas(id),
      "customerId" uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      sequence bigserial NOT NULL,
      fecha date NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      tipo varchar(20) NOT NULL CHECK (tipo IN ('SALDO_INICIAL', 'CARGO', 'PAGO', 'AJUSTE', 'ANULACION')),
      importe integer NOT NULL CHECK (importe <> 0),
      concepto varchar(160) NOT NULL,
      metodo varchar(20) CHECK (metodo IS NULL OR metodo IN ('CASH', 'TRANSFER', 'CHECK')),
      "receiptId" uuid,
      "anulaId" uuid REFERENCES cuenta_movimientos(id),
      numero varchar(30),
      motivo varchar(255),
      "usuarioId" uuid REFERENCES users(id),
      detalle jsonb
    )`);
    await r.query(
      'CREATE INDEX IF NOT EXISTS cuenta_movimientos_cliente ON cuenta_movimientos ("customerId", fecha, sequence)',
    );
    await r.query(
      'CREATE INDEX IF NOT EXISTS cuenta_movimientos_playa_fecha ON cuenta_movimientos ("playaId", fecha)',
    );
    // Una fila se anula una sola vez: dos anulaciones del mismo pago devolverían la plata dos veces.
    await r.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS cuenta_movimientos_una_anulacion ON cuenta_movimientos ("anulaId") WHERE "anulaId" IS NOT NULL',
    );

    await r.query('ALTER TABLE cuenta_movimientos ENABLE ROW LEVEL SECURITY');
    await r.query('ALTER TABLE cuenta_movimientos FORCE ROW LEVEL SECURITY');
    const [owner] = await r.query('SELECT current_user AS name');
    await r.query(
      `CREATE POLICY parking_system ON cuenta_movimientos TO "${owner.name.replace(/"/g, '""')}" USING (true) WITH CHECK (true)`,
    );
    await r.query(
      `CREATE POLICY parking_isolation ON cuenta_movimientos TO parking_scoped
       USING (current_setting('parking.platform', true) = 'yes' OR "playaId" = NULLIF(current_setting('parking.playa', true), '')::uuid)
       WITH CHECK (current_setting('parking.platform', true) = 'yes' OR "playaId" = NULLIF(current_setting('parking.playa', true), '')::uuid)`,
    );
    await r.query('GRANT SELECT, INSERT ON cuenta_movimientos TO parking_scoped');
    await r.query('GRANT USAGE, SELECT ON SEQUENCE cuenta_movimientos_sequence_seq TO parking_scoped');
    // Los mismos disparadores que el resto de las tablas de playa: completan el alcance y validan
    // que el cliente y el usuario referenciados sean visibles desde esta playa.
    await r.query(
      'CREATE OR REPLACE TRIGGER parking_a_stamp BEFORE INSERT OR UPDATE ON cuenta_movimientos FOR EACH ROW EXECUTE FUNCTION parking_stamp_scope()',
    );
    await r.query(
      'CREATE OR REPLACE TRIGGER parking_b_references BEFORE INSERT OR UPDATE ON cuenta_movimientos FOR EACH ROW EXECUTE FUNCTION parking_check_references()',
    );
  }

  async down(r: QueryRunner) {
    await r.query('DROP TABLE IF EXISTS cuenta_movimientos');
    await r.query('ALTER TABLE receipt_payments DROP COLUMN IF EXISTS "cuentaMovimientoId"');
    await r.query('ALTER TABLE receipts DROP COLUMN IF EXISTS concepto');
    await r.query('ALTER TABLE playas DROP COLUMN IF EXISTS modulos');
  }
}
