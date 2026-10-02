import { MigrationInterface, QueryRunner } from 'typeorm';

const HOY_AR = "(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date";

// La fecha de alta de cada cuenta, editable, y la lista de precios alineada con la landing.
//
// - `suscripciones.alta`: la fecha real de inicio del cliente. Se completa con el día (en
//   Argentina) en que se creó la empresa; `createdAt` se guardó en UTC sin zona.
// - Planes: los rangos pasan a 50 / 51 a 120 / más de 120 vehículos a la vez y el módulo se llama
//   «alquileres mensuales». Solo se tocan las filas que siguen con los valores de la semilla: si el
//   super admin ya los cambió desde el panel, se respetan.
//
// Idempotente, como todas: dos arranques simultáneos pueden correrla dos veces.
export class CuentaAlta1790000022000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(
      'ALTER TABLE suscripciones ADD COLUMN IF NOT EXISTS alta date',
    );
    await runner.query(`
      UPDATE suscripciones s
      SET alta = (((e."createdAt") AT TIME ZONE 'UTC') AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
      FROM empresas e
      WHERE e.id = s."empresaId" AND s.alta IS NULL
    `);
    await runner.query(
      `ALTER TABLE suscripciones ALTER COLUMN alta SET DEFAULT ${HOY_AR}`,
    );
    await runner.query(
      `UPDATE suscripciones SET alta = ${HOY_AR} WHERE alta IS NULL`,
    );
    await runner.query(
      'ALTER TABLE suscripciones ALTER COLUMN alta SET NOT NULL',
    );

    await runner.query(
      `UPDATE planes SET "maxActivos" = 50 WHERE codigo IN ('CHICA', 'CHICA_COCHERAS') AND "maxActivos" = 30`,
    );
    await runner.query(
      `UPDATE planes SET "maxActivos" = 120 WHERE codigo IN ('MEDIANA', 'MEDIANA_COCHERAS') AND "maxActivos" = 100`,
    );
    for (const tamano of ['chica', 'mediana', 'grande'])
      await runner.query(`UPDATE planes SET nombre = $1 WHERE nombre = $2`, [
        `Playa ${tamano} + alquileres`,
        `Playa ${tamano} + cocheras`,
      ]);
  }

  async down(runner: QueryRunner) {
    await runner.query('ALTER TABLE suscripciones DROP COLUMN IF EXISTS alta');
  }
}
