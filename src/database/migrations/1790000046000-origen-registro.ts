import { MigrationInterface, QueryRunner } from 'typeorm';

// Cómo se cargó cada entrada y cada salida, para las métricas de la plataforma: con el escáner de
// patentes (ESCANER), con el escáner pero corrigiendo la lectura (CORREGIDA), escrita a mano
// (MANUAL) o con la tarjeta física (TARJETA). Columnas nuevas y nulas: lo anterior queda sin dato,
// no se adivina. Los permisos de parking_scoped son por tabla, así que las cubren sin otro GRANT.
export class OrigenRegistro1790000046000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query('ALTER TABLE ticket_registrations ADD COLUMN IF NOT EXISTS "origenEntrada" varchar(12) NULL');
    await r.query('ALTER TABLE ticket_registrations ADD COLUMN IF NOT EXISTS "origenSalida" varchar(12) NULL');
  }

  async down(r: QueryRunner) {
    await r.query('ALTER TABLE ticket_registrations DROP COLUMN IF EXISTS "origenSalida"');
    await r.query('ALTER TABLE ticket_registrations DROP COLUMN IF EXISTS "origenEntrada"');
  }
}
