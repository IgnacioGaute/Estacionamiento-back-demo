import { MigrationInterface, QueryRunner } from 'typeorm';

// Lo que la ficha del super admin necesita para cobrar y contactar a una empresa: datos fiscales
// (razón social, CUIT, condición frente al IVA), una persona de contacto con su email y teléfono,
// y la ciudad. Además la capacidad de cada playa (para la ocupación) y el último acceso de cada
// usuario (lo actualiza JwtStrategy).
//
// Todo nullable y sin backfill: no hay de dónde sacar esos datos para lo que ya existe, y la ficha
// muestra «sin cargar». Columnas nuevas sin default: es un cambio de catálogo, no reescribe las
// tablas. Los CHECK se validan sobre columnas vacías. ADD COLUMN IF NOT EXISTS por si dos
// arranques corren la migración a la vez.
//
// RLS y grants no cambian: empresas, playas y users ya tienen GRANT SELECT de tabla para
// parking_scoped (TenantIsolation1790000001000) y estas columnas las escriben el super admin y
// la autenticación con el rol dueño. El CUIT se guarda solo con los 11 números.
export class DatosEmpresa1790000048000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query(`
      ALTER TABLE empresas
        ADD COLUMN IF NOT EXISTS "razonSocial" varchar(255),
        ADD COLUMN IF NOT EXISTS cuit varchar(11) CONSTRAINT empresas_cuit_formato CHECK (cuit ~ '^[0-9]{11}$'),
        ADD COLUMN IF NOT EXISTS "condicionIva" varchar(30) CONSTRAINT empresas_condicion_iva CHECK ("condicionIva" IN ('RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'EXENTO', 'CONSUMIDOR_FINAL')),
        ADD COLUMN IF NOT EXISTS "contactoNombre" varchar(255),
        ADD COLUMN IF NOT EXISTS "contactoEmail" varchar(255),
        ADD COLUMN IF NOT EXISTS "contactoTelefono" varchar(30),
        ADD COLUMN IF NOT EXISTS ciudad varchar(120),
        ADD COLUMN IF NOT EXISTS provincia varchar(60)
    `);
    await r.query(`
      ALTER TABLE playas
        ADD COLUMN IF NOT EXISTS capacidad integer CONSTRAINT playas_capacidad_positiva CHECK (capacidad > 0 AND capacidad <= 100000)
    `);
    await r.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "lastAccessAt" timestamptz`);
  }

  // Quitar las columnas pierde lo que se haya cargado (datos fiscales, contacto, capacidad y
  // último acceso): no hay copia en otro lado.
  async down(r: QueryRunner) {
    await r.query(`ALTER TABLE users DROP COLUMN IF EXISTS "lastAccessAt"`);
    await r.query(`ALTER TABLE playas DROP COLUMN IF EXISTS capacidad`);
    await r.query(`
      ALTER TABLE empresas
        DROP COLUMN IF EXISTS provincia,
        DROP COLUMN IF EXISTS ciudad,
        DROP COLUMN IF EXISTS "contactoTelefono",
        DROP COLUMN IF EXISTS "contactoEmail",
        DROP COLUMN IF EXISTS "contactoNombre",
        DROP COLUMN IF EXISTS "condicionIva",
        DROP COLUMN IF EXISTS cuit,
        DROP COLUMN IF EXISTS "razonSocial"
    `);
  }
}
