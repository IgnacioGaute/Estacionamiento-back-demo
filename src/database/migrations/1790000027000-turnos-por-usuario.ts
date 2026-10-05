import { MigrationInterface, QueryRunner } from 'typeorm';

export class TurnosPorUsuario1790000027000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    // No reasigna cobros ni modifica cierres históricos.
    await runner.query(`CREATE UNIQUE INDEX IF NOT EXISTS turnos_usuario_abierto
      ON turnos ("playaId", "usuarioAperturaId") WHERE estado = 'ABIERTO'`);
  }
  async down(runner: QueryRunner) {
    await runner.query('DROP INDEX IF EXISTS turnos_usuario_abierto');
  }
}
