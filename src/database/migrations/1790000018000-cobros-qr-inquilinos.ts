import { MigrationInterface, QueryRunner } from 'typeorm';

// Inquilinos: cobro con QR de MercadoPago y recibo de pago entregable.
//
// 1. MERCADOPAGO como medio posible de un asiento de la cuenta corriente y de lo aplicado a un
//    cargo. Solo lo escribe la acreditación automática (los DTOs no lo aceptan).
// 2. `cobros_mercadopago.detalle`: los cargos a cubrir y la nota de un cobro de inquilino, para
//    asentarlo al acreditarse igual que si se hubiera cobrado en el mostrador.
// El recibo público reutiliza parking_receipts con kind = 'PAGO' (la columna no tiene CHECK).
//
// Todo idempotente: dos arranques simultáneos del servidor pueden correrla a la vez.
export class CobrosQrInquilinos1790000018000 implements MigrationInterface {
  async up(r: QueryRunner) {
    // Agregar un valor a un enum dentro de la transacción es válido (PostgreSQL 12+) mientras no
    // se use en la misma transacción, y acá no se usa.
    await r.query(`ALTER TYPE receipt_payments_paymenttype_enum ADD VALUE IF NOT EXISTS 'MERCADOPAGO'`);
    await r.query(`ALTER TYPE receipts_paymenttype_enum ADD VALUE IF NOT EXISTS 'MERCADOPAGO'`);

    await r.query('ALTER TABLE cuenta_movimientos DROP CONSTRAINT IF EXISTS cuenta_movimientos_metodo_check');
    await r.query(`ALTER TABLE cuenta_movimientos ADD CONSTRAINT cuenta_movimientos_metodo_check
      CHECK (metodo IS NULL OR metodo IN ('CASH', 'TRANSFER', 'CHECK', 'MERCADOPAGO'))`);

    await r.query('ALTER TABLE cobros_mercadopago ADD COLUMN IF NOT EXISTS detalle jsonb');
  }

  async down(r: QueryRunner) {
    await r.query('ALTER TABLE cobros_mercadopago DROP COLUMN IF EXISTS detalle');
    await r.query('ALTER TABLE cuenta_movimientos DROP CONSTRAINT IF EXISTS cuenta_movimientos_metodo_check');
    await r.query(`ALTER TABLE cuenta_movimientos ADD CONSTRAINT cuenta_movimientos_metodo_check
      CHECK (metodo IS NULL OR metodo IN ('CASH', 'TRANSFER', 'CHECK'))`);
    // Un valor de enum no se puede quitar en PostgreSQL: MERCADOPAGO queda, sin uso.
  }
}
