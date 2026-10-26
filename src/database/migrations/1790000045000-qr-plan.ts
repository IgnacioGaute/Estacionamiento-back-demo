import { MigrationInterface, QueryRunner } from 'typeorm';

// Pagar el plan con QR: la orden de MercadoPago (en la cuenta de la plataforma) que la empresa
// tiene abierta. La pantalla la consulta mientras está el QR, y la revisión periódica también, por
// si se pagó y se cerró la pantalla antes de que se confirme. El pago se asienta una sola vez por
// su id, como el resto (índice único de facturas_saas). Columna nueva y nula; `suscripciones` ya
// tiene sus permisos por tabla: el rol de la empresa solo la lee.
export class QrPlan1790000045000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(
      'ALTER TABLE suscripciones ADD COLUMN IF NOT EXISTS "qrOrdenId" varchar(64)',
    );
  }

  async down(runner: QueryRunner) {
    await runner.query(
      'ALTER TABLE suscripciones DROP COLUMN IF EXISTS "qrOrdenId"',
    );
  }
}
