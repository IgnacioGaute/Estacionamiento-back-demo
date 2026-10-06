import { MigrationInterface, QueryRunner } from 'typeorm';

// Qué versión de las condiciones de uso de MercadoPago (src/mercadopago/condiciones.ts) aceptó la
// empresa al conectar su cuenta, quién y cuándo. Las cuentas conectadas antes quedan sin aceptar:
// siguen cobrando con QR, pero la consulta de pagos recibidos no corre hasta que un administrador
// acepte. La tabla ya tiene RLS por empresa y GRANT de tabla entera, así que no hace falta más.
export class CondicionesMercadoPago1790000029000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query(`ALTER TABLE mercadopago_cuentas
      ADD COLUMN IF NOT EXISTS "condicionesVersion" varchar(20),
      ADD COLUMN IF NOT EXISTS "condicionesAceptadasEl" timestamptz,
      ADD COLUMN IF NOT EXISTS "condicionesAceptadasPor" uuid`);
  }

  async down(r: QueryRunner) {
    await r.query(`ALTER TABLE mercadopago_cuentas
      DROP COLUMN IF EXISTS "condicionesVersion",
      DROP COLUMN IF EXISTS "condicionesAceptadasEl",
      DROP COLUMN IF EXISTS "condicionesAceptadasPor"`);
  }
}
