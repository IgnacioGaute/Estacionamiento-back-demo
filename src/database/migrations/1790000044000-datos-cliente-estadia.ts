import { MigrationInterface, QueryRunner } from 'typeorm';

// Documento (DNI) del cliente y modelo del vehículo en cada estadía, opcionales. El DNI lo pide la
// playa gratuita, donde apellido, DNI y tipo identifican a quién se deja entrar (no hay ticket ni
// cobro); el modelo se puede cargar en las dos modalidades. Columnas nuevas y nulas: las estadías existentes no se reescriben. Los permisos de
// parking_scoped son por tabla, así que las cubren sin otro GRANT.
export class DatosClienteEstadia1790000044000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query('ALTER TABLE ticket_registrations ADD COLUMN IF NOT EXISTS "documentoCustomer" varchar(20) NULL');
    await r.query('ALTER TABLE ticket_registrations ADD COLUMN IF NOT EXISTS "modeloVehiculo" varchar(60) NULL');
  }

  async down(r: QueryRunner) {
    await r.query('ALTER TABLE ticket_registrations DROP COLUMN IF EXISTS "modeloVehiculo"');
    await r.query('ALTER TABLE ticket_registrations DROP COLUMN IF EXISTS "documentoCustomer"');
  }
}
