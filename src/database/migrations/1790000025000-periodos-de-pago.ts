import { MigrationInterface, QueryRunner } from 'typeorm';

// Períodos de pago de la plataforma: mensual, trimestral (10% menos) y anual (15% menos), los de la
// landing.
//
// - `periodos_pago`: el catálogo, como `planes` (sin RLS: no es de nadie; el rol de las empresas
//   solo lo lee para mostrarles las opciones).
// - `suscripciones`: cada cuenta guarda su período con los meses y el descuento congelados. Las
//   que ya existían quedan mensuales, como venían.
// - `facturas_saas.descuento`: con qué descuento se calculó cada factura (las viejas, sin).
//
// Idempotente, como todas.
export class PeriodosDePago1790000025000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`
      CREATE TABLE IF NOT EXISTS periodos_pago (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        codigo varchar(20) NOT NULL,
        nombre varchar(60) NOT NULL,
        meses int NOT NULL,
        descuento int NOT NULL DEFAULT 0,
        activo boolean NOT NULL DEFAULT true,
        orden int NOT NULL DEFAULT 0,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await runner.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS periodos_pago_codigo ON periodos_pago (codigo)',
    );
    await runner.query(
      `INSERT INTO periodos_pago (codigo, nombre, meses, descuento, orden) VALUES
         ('MENSUAL', 'Mensual', 1, 0, 1),
         ('TRIMESTRAL', 'Trimestral', 3, 10, 2),
         ('ANUAL', 'Anual', 12, 15, 3)
       ON CONFLICT (codigo) DO NOTHING`,
    );
    await runner.query('GRANT SELECT ON periodos_pago TO parking_scoped');

    await runner.query(`
      ALTER TABLE suscripciones
        ADD COLUMN IF NOT EXISTS periodo varchar(20) NOT NULL DEFAULT 'MENSUAL',
        ADD COLUMN IF NOT EXISTS "periodoMeses" int NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS "periodoDescuento" int NOT NULL DEFAULT 0
    `);
    await runner.query(
      'ALTER TABLE facturas_saas ADD COLUMN IF NOT EXISTS descuento int NOT NULL DEFAULT 0',
    );
  }

  async down(runner: QueryRunner) {
    await runner.query(
      'ALTER TABLE facturas_saas DROP COLUMN IF EXISTS descuento',
    );
    await runner.query(`
      ALTER TABLE suscripciones
        DROP COLUMN IF EXISTS periodo,
        DROP COLUMN IF EXISTS "periodoMeses",
        DROP COLUMN IF EXISTS "periodoDescuento"
    `);
    await runner.query('DROP TABLE IF EXISTS periodos_pago');
  }
}
