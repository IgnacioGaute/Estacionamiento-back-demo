import { MigrationInterface, QueryRunner } from 'typeorm';

const quote = (s: string) => '"' + s.replace(/"/g, '""') + '"';

// Verificación de transferencias al alias (ver docs/verificacion-transferencias.md).
//
// 1. `empresa_adicionales`: lo que la plataforma le habilita a una empresa por fuera del plan, con
//    su precio pactado. Lo escribe solo el super admin (rol dueño); la empresa lo lee para saber si
//    lo tiene. Por ahora el precio NO entra en facturas ni débitos: se guarda aparte hasta que se
//    decida cómo se cobra.
// 2. En `mercadopago_cuentas`: el alias que la empresa le da a sus clientes y si activó la
//    verificación (quién y cuándo). Va en la cuenta porque el alias es de la cuenta.
// 3. `cobros_transferencia`: cada intento de cobrar una estadía por transferencia al alias.
// 4. `transferencias_recibidas`: las transferencias que entraron a la cuenta y coincidieron con
//    algún intento, con su estado (disponible, en revisión, usada).
//
// Las dos últimas se LEEN a nivel empresa y no de playa, a propósito: la cuenta de MercadoPago
// es una por empresa, así que para saber si una transferencia es inequívoca hay que ver los
// intentos de todas las playas que cobran con esa cuenta. Escribir un intento sigue siendo solo de
// su playa. Las transferencias son de la cuenta (empresa): una playa toma una para su cobro con un
// UPDATE condicional, y el índice único (cuenta, operación) impide usarla dos veces aunque dos
// cajas de playas distintas lo intenten a la vez.
export class VerificacionAlias1790000030000 implements MigrationInterface {
  async up(r: QueryRunner) {
    const [identity] = await r.query('SELECT current_user AS name');
    const owner = quote(identity.name);
    const platform = `current_setting('parking.platform', true) = 'yes'`;
    const empresa = `"empresaId" = NULLIF(current_setting('parking.empresa', true), '')::uuid`;
    const playa = `"playaId" = NULLIF(current_setting('parking.playa', true), '')::uuid`;

    const rls = async (tabla: string) => {
      await r.query(`ALTER TABLE ${tabla} ENABLE ROW LEVEL SECURITY`);
      await r.query(`ALTER TABLE ${tabla} FORCE ROW LEVEL SECURITY`);
      for (const p of [
        'parking_system',
        'parking_isolation',
        'parking_lectura',
        'parking_alta',
        'parking_cambio',
      ])
        await r.query(`DROP POLICY IF EXISTS ${p} ON ${tabla}`);
      await r.query(
        `CREATE POLICY parking_system ON ${tabla} TO ${owner} USING (true) WITH CHECK (true)`,
      );
    };

    // 1. Adicionales de la empresa.
    await r.query(`CREATE TABLE IF NOT EXISTS empresa_adicionales (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "empresaId" uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      codigo varchar(40) NOT NULL,
      habilitado boolean NOT NULL DEFAULT false,
      "precioMensual" int NOT NULL DEFAULT 0,
      "cambiadoPor" uuid,
      "habilitadoEl" timestamptz,
      "deshabilitadoEl" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await r.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS empresa_adicionales_codigo ON empresa_adicionales ("empresaId", codigo)',
    );
    await rls('empresa_adicionales');
    await r.query(
      `CREATE POLICY parking_isolation ON empresa_adicionales FOR SELECT TO parking_scoped USING (${platform} OR (${empresa}))`,
    );
    await r.query('GRANT SELECT ON empresa_adicionales TO parking_scoped');

    // 2. Alias y activación en la cuenta.
    await r.query(`ALTER TABLE mercadopago_cuentas
      ADD COLUMN IF NOT EXISTS alias varchar(60),
      ADD COLUMN IF NOT EXISTS "verificacionAlias" boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "verificacionAliasPor" uuid,
      ADD COLUMN IF NOT EXISTS "verificacionAliasEl" timestamptz`);

    // 3. Intentos de cobro por transferencia.
    await r.query(`CREATE TABLE IF NOT EXISTS cobros_transferencia (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "empresaId" uuid NOT NULL REFERENCES empresas(id),
      "playaId" uuid NOT NULL REFERENCES playas(id),
      "registrationId" uuid NOT NULL REFERENCES ticket_registrations(id) ON DELETE CASCADE,
      "mpUserId" varchar(64) NOT NULL,
      importe int NOT NULL,
      moneda varchar(3) NOT NULL DEFAULT 'ARS',
      estado varchar(20) NOT NULL DEFAULT 'ESPERANDO',
      "buscarDesde" timestamptz NOT NULL,
      "ventanaMinutos" int NOT NULL DEFAULT 1,
      "venceEl" timestamptz NOT NULL,
      "cerradoEl" timestamptz,
      "operacionId" varchar(64),
      modo varchar(40),
      "salidaRegistrada" boolean NOT NULL DEFAULT false,
      "saldoPendiente" int,
      "creadoPor" uuid,
      "confirmadoPor" uuid,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await r.query(
      'CREATE INDEX IF NOT EXISTS tenant_cobros_transferencia ON cobros_transferencia ("playaId")',
    );
    await r.query(
      'CREATE INDEX IF NOT EXISTS cobros_transferencia_cuenta ON cobros_transferencia ("empresaId", "mpUserId", estado)',
    );
    // Un solo intento abierto por estadía: abrir otro devuelve el que ya estaba.
    await r.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS cobros_transferencia_abierto ON cobros_transferencia ("registrationId") WHERE estado IN ('ESPERANDO', 'REVISION')`,
    );
    // Una operación de MercadoPago confirma un solo intento.
    await r.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS cobros_transferencia_operacion ON cobros_transferencia ("mpUserId", "operacionId") WHERE "operacionId" IS NOT NULL',
    );
    await rls('cobros_transferencia');
    await r.query(
      `CREATE POLICY parking_lectura ON cobros_transferencia FOR SELECT TO parking_scoped USING (${platform} OR (${empresa}))`,
    );
    await r.query(
      `CREATE POLICY parking_alta ON cobros_transferencia FOR INSERT TO parking_scoped WITH CHECK (${platform} OR ((${playa}) AND (${empresa})))`,
    );
    await r.query(
      `CREATE POLICY parking_cambio ON cobros_transferencia FOR UPDATE TO parking_scoped USING (${platform} OR ((${playa}) AND (${empresa}))) WITH CHECK (${platform} OR ((${playa}) AND (${empresa})))`,
    );
    await r.query(
      'GRANT SELECT, INSERT, UPDATE ON cobros_transferencia TO parking_scoped',
    );
    await r.query(
      'DROP TRIGGER IF EXISTS parking_a_stamp ON cobros_transferencia',
    );
    await r.query(
      'CREATE TRIGGER parking_a_stamp BEFORE INSERT OR UPDATE ON cobros_transferencia FOR EACH ROW EXECUTE FUNCTION parking_stamp_scope()',
    );
    await r.query(
      'DROP TRIGGER IF EXISTS parking_b_references ON cobros_transferencia',
    );
    await r.query(
      'CREATE TRIGGER parking_b_references BEFORE INSERT OR UPDATE ON cobros_transferencia FOR EACH ROW EXECUTE FUNCTION parking_check_references()',
    );

    // 4. Transferencias recibidas que coincidieron con algún intento. Sin datos de quien pagó: el
    //    nombre se muestra en el momento, desde MercadoPago, y no se guarda. La playa donde se usó
    //    no se llama `playaId` a propósito: con ese nombre el subscriber de tenant-context la
    //    estamparía al detectarla, atándola a la playa que la vio primero.
    await r.query(`CREATE TABLE IF NOT EXISTS transferencias_recibidas (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "empresaId" uuid NOT NULL REFERENCES empresas(id),
      "mpUserId" varchar(64) NOT NULL,
      "operacionId" varchar(64) NOT NULL,
      importe numeric(14, 2) NOT NULL,
      moneda varchar(3) NOT NULL,
      "estadoMp" varchar(30) NOT NULL,
      "fechaOperacion" timestamptz NOT NULL,
      "fechaAcreditacion" timestamptz,
      "detectadaEl" timestamptz NOT NULL DEFAULT now(),
      estado varchar(20) NOT NULL DEFAULT 'DISPONIBLE',
      "cobroId" uuid,
      "registrationId" uuid,
      "usadaEnPlayaId" uuid,
      modo varchar(40),
      "usadaEl" timestamptz,
      "usadaPor" uuid,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await r.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS transferencias_recibidas_operacion ON transferencias_recibidas ("mpUserId", "operacionId")',
    );
    await r.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS transferencias_recibidas_cobro ON transferencias_recibidas ("cobroId") WHERE "cobroId" IS NOT NULL',
    );
    await r.query(
      'CREATE INDEX IF NOT EXISTS transferencias_recibidas_cuenta ON transferencias_recibidas ("empresaId", "mpUserId", estado, "fechaOperacion")',
    );
    await rls('transferencias_recibidas');
    await r.query(
      `CREATE POLICY parking_isolation ON transferencias_recibidas TO parking_scoped USING (${platform} OR (${empresa})) WITH CHECK (${platform} OR (${empresa}))`,
    );
    await r.query(
      'GRANT SELECT, INSERT, UPDATE ON transferencias_recibidas TO parking_scoped',
    );
    await r.query(
      'DROP TRIGGER IF EXISTS parking_b_references ON transferencias_recibidas',
    );
    await r.query(
      'CREATE TRIGGER parking_b_references BEFORE INSERT OR UPDATE ON transferencias_recibidas FOR EACH ROW EXECUTE FUNCTION parking_check_references()',
    );
  }

  async down(r: QueryRunner) {
    await r.query('DROP TABLE IF EXISTS transferencias_recibidas');
    await r.query('DROP TABLE IF EXISTS cobros_transferencia');
    await r.query(`ALTER TABLE mercadopago_cuentas
      DROP COLUMN IF EXISTS alias,
      DROP COLUMN IF EXISTS "verificacionAlias",
      DROP COLUMN IF EXISTS "verificacionAliasPor",
      DROP COLUMN IF EXISTS "verificacionAliasEl"`);
    await r.query('DROP TABLE IF EXISTS empresa_adicionales');
  }
}
