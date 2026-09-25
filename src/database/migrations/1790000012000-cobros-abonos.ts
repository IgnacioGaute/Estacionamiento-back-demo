import { MigrationInterface, QueryRunner } from 'typeorm';

// El cobro con QR también sirve para los abonos por día, semana y mes, y esos viven en otra tabla
// (ticket_registration_for_days), no en ticket_registrations.
//
// Por eso se saca la clave foránea: `registrationId` pasa a apuntar a una u otra según `tipo`. Es
// el mismo camino que ya tomó parking_receipts, que guarda su `registrationId` como columna suelta
// justamente porque puede referirse a cualquiera de las dos.
//
// Sacarla no deja la referencia sin control: el trigger parking_check_references sólo valida las
// FK declaradas, así que lo que se pierde es una verificación que de todos modos no podía existir
// para dos tablas destino. Quién valida ahora es el servicio, que busca el registro antes de
// cobrar y falla si no existe en la playa.
export class CobrosAbonos1790000012000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(
      `ALTER TABLE cobros_mercadopago DROP CONSTRAINT IF EXISTS "cobros_mercadopago_registrationId_fkey"`,
    );
    await runner.query(
      `ALTER TABLE cobros_mercadopago ADD COLUMN IF NOT EXISTS tipo varchar(10) NOT NULL DEFAULT 'HORA'`,
    );
  }

  async down(runner: QueryRunner) {
    await runner.query(
      'ALTER TABLE cobros_mercadopago DROP COLUMN IF EXISTS tipo',
    );
    // La FK no se repone: si ya hay cobros de abonos, apuntan a la otra tabla y el ALTER fallaría.
  }
}
