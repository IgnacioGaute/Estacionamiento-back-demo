import { MigrationInterface, QueryRunner } from 'typeorm';

export class AliasInquilinos1790000035000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query('ALTER TABLE cobros_transferencia ADD COLUMN IF NOT EXISTS detalle jsonb');
    await r.query('ALTER TABLE cobros_transferencia DROP CONSTRAINT IF EXISTS cobros_transferencia_tipo');
    await r.query(`ALTER TABLE cobros_transferencia ADD CONSTRAINT cobros_transferencia_tipo CHECK (tipo IN ('HORA','ABONO','INQUILINO'))`);
    await r.query(`CREATE OR REPLACE FUNCTION parking_check_alias_registration() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE visible boolean;
      BEGIN
        IF current_user <> 'parking_scoped' OR current_setting('parking.platform', true) = 'yes' THEN RETURN NEW; END IF;
        IF NEW.tipo = 'INQUILINO' THEN
          SELECT EXISTS(SELECT 1 FROM customers WHERE id=NEW."registrationId" AND "playaId"=NEW."playaId" AND "customerType"='RENTER') INTO visible;
        ELSIF NEW.tipo = 'ABONO' THEN
          SELECT EXISTS(SELECT 1 FROM ticket_registration_for_days WHERE id=NEW."registrationId" AND "playaId"=NEW."playaId") INTO visible;
        ELSE
          SELECT EXISTS(SELECT 1 FROM ticket_registrations WHERE id=NEW."registrationId" AND "playaId"=NEW."playaId") INTO visible;
        END IF;
        IF NOT visible THEN RAISE EXCEPTION 'Referencia fuera de la empresa o playa permitida' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$`);
  }
  async down() { throw new Error('Conservar la evidencia de las transferencias de inquilinos.'); }
}
