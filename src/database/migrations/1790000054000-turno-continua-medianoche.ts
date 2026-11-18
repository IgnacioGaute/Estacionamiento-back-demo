import { MigrationInterface, QueryRunner } from 'typeorm';

// A las 00:00 el turno abierto se corta y sigue en una continuación (como hasta ahora), salvo que la
// playa lo apague en Turnos de caja: entonces se cierran el turno y la caja sin contar, y el próximo
// operador abre la suya contando lo que recibe. Las playas existentes conservan la continuación.
// cash_sessions.cierreAutomatico distingue esa caja cerrada por el sistema de un arqueo.
export class TurnoContinuaMedianoche1790000054000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query('ALTER TABLE ticket_schedule_settings ADD COLUMN IF NOT EXISTS "continuarTurnoMedianoche" boolean NOT NULL DEFAULT true');
    await r.query('ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS "cierreAutomatico" boolean NOT NULL DEFAULT false');
  }

  async down(r: QueryRunner) {
    await r.query('ALTER TABLE cash_sessions DROP COLUMN IF EXISTS "cierreAutomatico"');
    await r.query('ALTER TABLE ticket_schedule_settings DROP COLUMN IF EXISTS "continuarTurnoMedianoche"');
  }
}
