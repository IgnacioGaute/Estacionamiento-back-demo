import { MigrationInterface, QueryRunner } from 'typeorm';

// Cuenta corriente de inquilinos, segunda vuelta (revisión contable):
//
// 1. Los recibos de un inquilino son cargos de su cuenta. Se les agrega el tipo (`ABONO`,
//    `RECARGO`, `SALDO_INICIAL`) en un campo propio —antes se deducía del texto—, el período del
//    abono y el vencimiento, para distinguir lo pendiente de lo vencido.
// 2. Un inquilino tiene a lo sumo un cargo por período: índice único parcial. Si la historia ya
//    tenía dos del mismo mes, el más viejo queda como el del período y el resto sigue como cargo
//    sin período (no se borra ni se cambia ningún importe).
// 3. `ticket_schedule_settings.vencimientoAbonoDia`: el día del mes en que vence el abono.
// 4. `cuenta_movimientos.solicitud`: identificador de cada cobro que manda la pantalla, único por
//    medio de pago, para que reintentar un cobro cuya respuesta se perdió no lo registre dos veces.
// 5. Tipo DEVOLUCION en el libro: plata que efectivamente se le devolvió al inquilino.
// 6. Dar de baja a un inquilino ocultaba también sus cargos, y con ellos la deuda. Se recuperan
//    los que ocultó la baja cuando la cuenta corriente ya los tenía asentados, o cuando la cuenta
//    todavía no se armó (se va a armar con ellos). Si la cuenta se armó sin ellos, se dejan como
//    están: devolverlos crearía deuda que el libro no tiene.
export class CuentasCargosVencimientos1790000017000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query('ALTER TABLE receipts ADD COLUMN IF NOT EXISTS "tipoCargo" varchar(20)');
    await r.query('ALTER TABLE receipts ADD COLUMN IF NOT EXISTS periodo char(7)');
    await r.query('ALTER TABLE receipts ADD COLUMN IF NOT EXISTS vencimiento date');
    await r.query('ALTER TABLE ticket_schedule_settings ADD COLUMN IF NOT EXISTS "vencimientoAbonoDia" int NOT NULL DEFAULT 10');
    await r.query('ALTER TABLE cuenta_movimientos ADD COLUMN IF NOT EXISTS solicitud uuid');

    // 6 · antes que el resto, así los cargos recuperados también reciben tipo y período.
    await r.query(`
      UPDATE receipts r SET "deletedAt" = NULL
      FROM customers c
      WHERE c.id = r."customerId" AND c."customerType" = 'RENTER' AND c."deletedAt" IS NOT NULL
        AND r."deletedAt" IS NOT NULL
        AND r."deletedAt" BETWEEN c."deletedAt" - interval '5 minutes' AND c."deletedAt" + interval '5 minutes'
        AND (
          EXISTS (SELECT 1 FROM cuenta_movimientos m WHERE m."receiptId" = r.id)
          OR NOT EXISTS (SELECT 1 FROM cuenta_movimientos m WHERE m."customerId" = c.id)
        )`);

    // 1 · tipo, período y vencimiento de los cargos existentes de inquilinos.
    await r.query(`
      UPDATE receipts r SET
        "tipoCargo" = CASE
          WHEN r.concepto LIKE 'Recargo%' THEN 'RECARGO'
          WHEN r.concepto LIKE 'Saldo inicial%' OR r.concepto LIKE 'Deuda %' THEN 'SALDO_INICIAL'
          ELSE 'ABONO' END,
        periodo = CASE
          WHEN r.concepto LIKE 'Recargo%' OR r.concepto LIKE 'Saldo inicial%' THEN NULL
          ELSE to_char(COALESCE(r."startDate", r."dateNow", r."createdAt"::date), 'YYYY-MM') END
      FROM customers c
      WHERE c.id = r."customerId" AND c."customerType" = 'RENTER' AND r."tipoCargo" IS NULL`);
    await r.query(`
      UPDATE receipts SET vencimiento = CASE
        WHEN periodo IS NOT NULL THEN (periodo || '-10')::date
        ELSE COALESCE("startDate", "dateNow", "createdAt"::date) END
      WHERE "tipoCargo" IS NOT NULL AND vencimiento IS NULL`);

    // 2 · un cargo por período: el más viejo se queda con el período.
    await r.query(`
      WITH repetidos AS (
        SELECT id, row_number() OVER (PARTITION BY "customerId", periodo ORDER BY "createdAt", id) AS n
        FROM receipts WHERE periodo IS NOT NULL AND "deletedAt" IS NULL
      )
      UPDATE receipts SET periodo = NULL FROM repetidos WHERE receipts.id = repetidos.id AND repetidos.n > 1`);
    await r.query(`CREATE UNIQUE INDEX IF NOT EXISTS receipts_cargo_periodo_unico
      ON receipts ("customerId", periodo) WHERE periodo IS NOT NULL AND "deletedAt" IS NULL`);

    // 4 · un cobro no se registra dos veces.
    await r.query(`CREATE UNIQUE INDEX IF NOT EXISTS cuenta_movimientos_solicitud_unica
      ON cuenta_movimientos (solicitud, metodo) WHERE solicitud IS NOT NULL`);

    // 5 · devoluciones.
    await r.query('ALTER TABLE cuenta_movimientos DROP CONSTRAINT IF EXISTS cuenta_movimientos_tipo_check');
    await r.query(`ALTER TABLE cuenta_movimientos ADD CONSTRAINT cuenta_movimientos_tipo_check
      CHECK (tipo IN ('SALDO_INICIAL', 'CARGO', 'PAGO', 'AJUSTE', 'ANULACION', 'DEVOLUCION'))`);
  }

  async down(r: QueryRunner) {
    await r.query('ALTER TABLE cuenta_movimientos DROP CONSTRAINT IF EXISTS cuenta_movimientos_tipo_check');
    await r.query(`ALTER TABLE cuenta_movimientos ADD CONSTRAINT cuenta_movimientos_tipo_check
      CHECK (tipo IN ('SALDO_INICIAL', 'CARGO', 'PAGO', 'AJUSTE', 'ANULACION'))`);
    await r.query('DROP INDEX IF EXISTS cuenta_movimientos_solicitud_unica');
    await r.query('DROP INDEX IF EXISTS receipts_cargo_periodo_unico');
    await r.query('ALTER TABLE cuenta_movimientos DROP COLUMN IF EXISTS solicitud');
    await r.query('ALTER TABLE ticket_schedule_settings DROP COLUMN IF EXISTS "vencimientoAbonoDia"');
    await r.query('ALTER TABLE receipts DROP COLUMN IF EXISTS vencimiento');
    await r.query('ALTER TABLE receipts DROP COLUMN IF EXISTS periodo');
    await r.query('ALTER TABLE receipts DROP COLUMN IF EXISTS "tipoCargo"');
  }
}
