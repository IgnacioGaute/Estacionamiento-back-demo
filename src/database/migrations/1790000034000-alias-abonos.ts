import { MigrationInterface, QueryRunner } from 'typeorm';

export class AliasAbonos1790000034000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query(`ALTER TABLE cobros_transferencia ADD COLUMN IF NOT EXISTS tipo varchar(10) NOT NULL DEFAULT 'HORA'`);
    // El mismo identificador polimórfico que cobros_mercadopago.
    const keys = await r.query(`SELECT c.conname FROM pg_constraint c JOIN pg_attribute a
      ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
      WHERE c.conrelid='cobros_transferencia'::regclass AND c.contype='f' AND a.attname='registrationId'`);
    for (const k of keys) await r.query(`ALTER TABLE cobros_transferencia DROP CONSTRAINT "${k.conname.replace(/"/g, '""')}"`);
    await r.query('DROP INDEX IF EXISTS cobros_transferencia_abierto');
    await r.query(`CREATE UNIQUE INDEX cobros_transferencia_abierto ON cobros_transferencia ("registrationId", tipo) WHERE estado IN ('ESPERANDO', 'REVISION')`);
    await r.query(`ALTER TABLE cobros_transferencia ADD CONSTRAINT cobros_transferencia_tipo CHECK (tipo IN ('HORA','ABONO'))`);
    // Reemplaza la comprobación de la FK por la del destino real, conservando el alcance de playa.
    await r.query(`CREATE OR REPLACE FUNCTION parking_check_alias_registration() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE visible boolean;
      BEGIN
        IF current_user <> 'parking_scoped' OR current_setting('parking.platform', true) = 'yes' THEN RETURN NEW; END IF;
        IF NEW.tipo = 'ABONO' THEN
          SELECT EXISTS(SELECT 1 FROM ticket_registration_for_days WHERE id=NEW."registrationId" AND "playaId"=NEW."playaId") INTO visible;
        ELSE
          SELECT EXISTS(SELECT 1 FROM ticket_registrations WHERE id=NEW."registrationId" AND "playaId"=NEW."playaId") INTO visible;
        END IF;
        IF NOT visible THEN RAISE EXCEPTION 'Referencia fuera de la empresa o playa permitida' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$`);
    await r.query(`CREATE TRIGGER parking_c_alias_registration BEFORE INSERT OR UPDATE ON cobros_transferencia FOR EACH ROW EXECUTE FUNCTION parking_check_alias_registration()`);
  }
  async down() { throw new Error('Conservar la evidencia de las transferencias de abonos.'); }
}
