import { MigrationInterface, QueryRunner } from 'typeorm';

// El avance de la configuración inicial de cada playa (ver src/tenancy/configuracion-inicial.ts).
// Las playas que ya existen están funcionando: la columna entra con un default «terminada», que es
// lo que reciben esas filas, y recién después el default pasa a '{}' (pendiente) para las que se
// creen desde ahora. Si la columna ya está, no se toca nada: repetir la migración no puede dar por
// terminada una playa que está a mitad del recorrido.
// La columna es de `playas`, que el rol de la empresa solo lee: no hace falta ningún GRANT nuevo
// (la escritura la hace ConfiguracionInicialService fuera del scope).
export class ConfiguracionInicial1790000047000 implements MigrationInterface {
  async up(r: QueryRunner) {
    const [existe] = await r.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'playas' AND column_name = 'configuracionInicial'`,
    );
    if (existe) return;
    await r.query(
      `ALTER TABLE playas ADD COLUMN "configuracionInicial" jsonb NOT NULL
       DEFAULT jsonb_build_object('terminadaEn', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'anterior', true)`,
    );
    await r.query(`ALTER TABLE playas ALTER COLUMN "configuracionInicial" SET DEFAULT '{}'::jsonb`);
  }

  // Quitar la columna pierde el avance de las playas que estaban a mitad del recorrido.
  async down(r: QueryRunner) {
    await r.query('ALTER TABLE playas DROP COLUMN IF EXISTS "configuracionInicial"');
  }
}
