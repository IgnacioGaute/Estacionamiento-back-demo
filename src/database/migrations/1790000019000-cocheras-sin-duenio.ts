import { MigrationInterface, QueryRunner } from 'typeorm';

// Inquilinos: una cochera ya no necesita «propietario». Se carga con su número y su precio
// mensual, y listo. Hasta ahora `owner` era obligatorio y guardaba el id de un propietario real o
// el nombre de un tipo de dueño (Aznar, Fontela…), del que salía el precio sin poder cambiarlo.
// Las cocheras que ya tienen dueño lo conservan; Particulares sigue alquilando cocheras de
// propietarios reales.
//
// Idempotente: dos arranques simultáneos del servidor pueden correrla a la vez.
export class CocherasSinDuenio1790000019000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query('ALTER TABLE vehicle_renters ALTER COLUMN owner DROP NOT NULL');
  }

  async down(r: QueryRunner) {
    await r.query(`UPDATE vehicle_renters SET owner = '' WHERE owner IS NULL`);
    await r.query('ALTER TABLE vehicle_renters ALTER COLUMN owner SET NOT NULL');
  }
}
