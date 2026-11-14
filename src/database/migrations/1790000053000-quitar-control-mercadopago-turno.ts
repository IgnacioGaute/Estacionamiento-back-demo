import { MigrationInterface, QueryRunner } from 'typeorm';

// Se sacó el control de Mercado Pago del turno (1790000052000): la cuenta de la empresa también
// recibe plata que no es de la playa, así que el total no servía para explicar la caja. Los
// totales guardados eran derivados de Mercado Pago y no tienen otro uso.
export class QuitarControlMercadoPagoTurno1790000053000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query('ALTER TABLE turnos DROP COLUMN IF EXISTS "controlMercadoPago"');
  }

  async down(r: QueryRunner) {
    await r.query('ALTER TABLE turnos ADD COLUMN IF NOT EXISTS "controlMercadoPago" jsonb');
  }
}
