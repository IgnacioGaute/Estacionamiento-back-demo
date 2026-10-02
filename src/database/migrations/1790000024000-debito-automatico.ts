import { MigrationInterface, QueryRunner } from 'typeorm';

// Débito automático y pagos con MercadoPago de la cuenta de cada empresa con la plataforma.
//
// - `suscripciones`: el id de la suscripción de MercadoPago («preapproval»), su estado, el email
//   con que se autorizó, la url para terminar de confirmarla y el importe que tiene cargado.
// - `facturas_saas`: un pago de MercadoPago se registra una sola vez. El índice único sobre su id
//   (en `referencia`) es la última red si el aviso, la verificación al volver y la revisión diaria
//   llegan juntos. Incluye las anuladas: un pago ya registrado y anulado no se vuelve a cargar solo.
//
// Idempotente, como todas.
export class DebitoAutomatico1790000024000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`
      ALTER TABLE suscripciones
        ADD COLUMN IF NOT EXISTS "debitoId" varchar(64),
        ADD COLUMN IF NOT EXISTS "debitoEstado" varchar(20),
        ADD COLUMN IF NOT EXISTS "debitoEmail" varchar(255),
        ADD COLUMN IF NOT EXISTS "debitoUrl" text,
        ADD COLUMN IF NOT EXISTS "debitoImporte" int
    `);
    await runner.query(
      'CREATE INDEX IF NOT EXISTS suscripciones_debito ON suscripciones ("debitoId")',
    );
    await runner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS facturas_saas_pago_mercadopago
       ON facturas_saas (referencia) WHERE medio = 'MERCADOPAGO' AND referencia IS NOT NULL`,
    );
  }

  async down(runner: QueryRunner) {
    await runner.query('DROP INDEX IF EXISTS facturas_saas_pago_mercadopago');
    await runner.query('DROP INDEX IF EXISTS suscripciones_debito');
    await runner.query(`
      ALTER TABLE suscripciones
        DROP COLUMN IF EXISTS "debitoId",
        DROP COLUMN IF EXISTS "debitoEstado",
        DROP COLUMN IF EXISTS "debitoEmail",
        DROP COLUMN IF EXISTS "debitoUrl",
        DROP COLUMN IF EXISTS "debitoImporte"
    `);
  }
}
