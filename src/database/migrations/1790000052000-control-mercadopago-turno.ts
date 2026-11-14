import { MigrationInterface, QueryRunner } from 'typeorm';

// Al cerrar un turno se guarda cuánto entró a la cuenta de Mercado Pago de la empresa en el horario
// del turno y cuánto registró el sistema por Mercado Pago y transferencias. Solo totales: ningún
// pago ni datos de quien pagó (condiciones de uso 2026-11-13). Null: no se consultó.
export class ControlMercadoPagoTurno1790000052000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query('ALTER TABLE turnos ADD COLUMN IF NOT EXISTS "controlMercadoPago" jsonb');
  }

  async down(r: QueryRunner) {
    await r.query('ALTER TABLE turnos DROP COLUMN IF EXISTS "controlMercadoPago"');
  }
}
