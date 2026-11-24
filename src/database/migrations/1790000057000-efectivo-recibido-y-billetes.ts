import { MigrationInterface, QueryRunner } from 'typeorm';

// Faltantes de caja sin una causa clara: el operador podía confirmar un cobro en efectivo sin decir
// con cuánto le pagaron, y el arqueo final se escribía como un total.
// - movimientos y ticket_registration_for_days: lo que el operador declaró recibir y el vuelto que
//   calculó el servidor, junto al cobro en efectivo. No son importes del libro ni de la caja.
// - turnos y cash_sessions: el desglose por billetes del arqueo final y del primer conteo.
// Columnas nuevas y nulas: los cobros y cierres anteriores quedan sin estos datos (no se inventan).
// Las tablas ya tienen RLS, grants y triggers; agregar columnas no los cambia.
export class EfectivoRecibidoYBilletes1790000057000 implements MigrationInterface {
  async up(r: QueryRunner) {
    for (const tabla of ['movimientos', 'ticket_registration_for_days']) {
      await r.query(`ALTER TABLE ${tabla} ADD COLUMN IF NOT EXISTS "efectivoRecibido" int`);
      await r.query(`ALTER TABLE ${tabla} ADD COLUMN IF NOT EXISTS vuelto int`);
    }
    for (const tabla of ['turnos', 'cash_sessions']) {
      await r.query(`ALTER TABLE ${tabla} ADD COLUMN IF NOT EXISTS "conteoDesglose" jsonb`);
      await r.query(`ALTER TABLE ${tabla} ADD COLUMN IF NOT EXISTS "primerConteoDesglose" jsonb`);
    }
  }

  async down() { throw new Error('Se conservan lo recibido, los vueltos y los conteos por billetes.'); }
}
