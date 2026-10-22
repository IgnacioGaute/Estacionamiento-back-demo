import { MigrationInterface, QueryRunner } from 'typeorm';

export class SuperadminOperativo1790000043000 implements MigrationInterface {
  async up(r: QueryRunner) {
    // El superadministrador no pertenece a una empresa, pero debe poder figurar como autor de
    // entradas, cobros y turnos sin desactivar la validación de referencias entre playas.
    // Esta política solo permite leer su propia fila; no permite modificarla desde la operación.
    await r.query('DROP POLICY IF EXISTS parking_actor ON users');
    await r.query(`CREATE POLICY parking_actor ON users FOR SELECT TO parking_scoped
      USING (role = 'SUPER_ADMIN' AND id = NULLIF(current_setting('parking.actor', true), '')::uuid)`);
  }

  async down(r: QueryRunner) {
    await r.query('DROP POLICY IF EXISTS parking_actor ON users');
  }
}
