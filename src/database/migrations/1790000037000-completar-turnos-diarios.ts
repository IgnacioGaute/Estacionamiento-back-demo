import { MigrationInterface, QueryRunner } from 'typeorm';
import { TurnosDiarios1790000036000 } from './1790000036000-turnos-diarios';

// Algunas instalaciones ejecutaron la versión inicial del corte diario antes de que
// incorporara salidasRegistradas y las referencias. Una migración registrada no vuelve
// a ejecutarse al reiniciar: completar el esquema requiere un paso nuevo.
export class CompletarTurnosDiarios1790000037000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    // El esquema es idempotente: agrega lo que falta y conserva los registros existentes.
    await new TurnosDiarios1790000036000().up(runner);
  }

  async down() {
    throw new Error('Se conservan los cortes diarios y los retiros de sueldo.');
  }
}
