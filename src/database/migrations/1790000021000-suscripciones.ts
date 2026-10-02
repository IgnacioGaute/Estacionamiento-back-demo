import { MigrationInterface, QueryRunner } from 'typeorm';

const quote = (s: string) => '"' + s.replace(/"/g, '""') + '"';

// La lista de precios con la que arranca la plataforma. Se edita después desde el panel; la
// migración solo la carga si no está (ON CONFLICT), así que no pisa precios ya cambiados.
const PLANES: [string, string, number | null, boolean, number, number][] = [
  ['CHICA', 'Playa chica', 30, false, 50_000, 10],
  ['MEDIANA', 'Playa mediana', 100, false, 70_000, 20],
  ['GRANDE', 'Playa grande', null, false, 110_000, 30],
  ['CHICA_COCHERAS', 'Playa chica + cocheras', 30, true, 70_000, 40],
  ['MEDIANA_COCHERAS', 'Playa mediana + cocheras', 100, true, 95_000, 50],
  ['GRANDE_COCHERAS', 'Playa grande + cocheras', null, true, 140_000, 60],
];

// Planes y cuentas de las empresas con la plataforma (ver src/saas).
//
// Las entidades `planes`, `suscripciones` y `facturas_saas` existían desde antes pero nada las
// usaba, con otra forma. Una base creada con DB_BOOTSTRAP puede tenerlas con esa forma vieja:
// se reconocen por una columna que ya no existe y se descartan si están vacías (o se guardan
// con otro nombre si alguien les cargó algo a mano). Todo lo demás es IF NOT EXISTS, porque una
// base nueva ya las trae con la forma actual y porque dos arranques simultáneos pueden correr la
// misma migración.
//
// Aislamiento: la plataforma (super admin y la tarea diaria) corre con el rol dueño; la empresa
// solo LEE su propia cuenta con `parking_scoped`, filtrada por empresa como mercadopago_cuentas.
// No tiene INSERT ni UPDATE: ninguna ruta de la empresa puede cambiar su plan ni su vencimiento.
export class Suscripciones1790000021000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await this.retirarFormaVieja(runner, 'facturas_saas', 'suscripcionId');
    await this.retirarFormaVieja(runner, 'suscripciones', 'planId');
    await this.retirarFormaVieja(runner, 'planes', 'maxPlayas');

    await runner.query(`
      CREATE TABLE IF NOT EXISTS planes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        codigo varchar(40) NOT NULL,
        nombre varchar(100) NOT NULL,
        "maxActivos" int,
        "incluyeCocheras" boolean NOT NULL DEFAULT false,
        "precioMensual" int NOT NULL,
        activo boolean NOT NULL DEFAULT true,
        orden int NOT NULL DEFAULT 0,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await runner.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS planes_codigo ON planes (codigo)',
    );

    await runner.query(`
      CREATE TABLE IF NOT EXISTS suscripciones (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "empresaId" uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
        "pruebaHasta" date,
        "pagadoHasta" date,
        "prorrogaHasta" date,
        bonificada boolean NOT NULL DEFAULT false,
        "motivoSuspension" varchar(20),
        "suspendidaEl" timestamptz,
        notas text,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await runner.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS suscripciones_empresa ON suscripciones ("empresaId")',
    );

    await runner.query(`
      CREATE TABLE IF NOT EXISTS suscripcion_playas (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "empresaId" uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
        "playaId" uuid NOT NULL REFERENCES playas(id) ON DELETE CASCADE,
        "planId" uuid NOT NULL REFERENCES planes(id),
        precio int NOT NULL,
        desde date NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await runner.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS suscripcion_playas_playa ON suscripcion_playas ("playaId")',
    );
    await runner.query(
      'CREATE INDEX IF NOT EXISTS suscripcion_playas_empresa ON suscripcion_playas ("empresaId")',
    );

    await runner.query(`
      CREATE TABLE IF NOT EXISTS facturas_saas (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "empresaId" uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
        desde date NOT NULL,
        hasta date NOT NULL,
        meses int NOT NULL DEFAULT 1,
        importe int NOT NULL,
        detalle jsonb NOT NULL DEFAULT '[]'::jsonb,
        estado varchar(20) NOT NULL DEFAULT 'PENDIENTE',
        "pagadaEl" date,
        medio varchar(20),
        referencia varchar(255),
        nota text,
        "registradaPor" uuid,
        "pagadoHastaAnterior" date,
        "motivoAnulacion" text,
        "anuladaEl" timestamptz,
        "anuladaPor" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await runner.query(
      'CREATE INDEX IF NOT EXISTS facturas_saas_empresa_desde ON facturas_saas ("empresaId", desde)',
    );
    // Una sola pendiente por empresa: si la tarea diaria corre dos veces a la vez, la segunda choca.
    await runner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS facturas_saas_pendiente_unica ON facturas_saas ("empresaId") WHERE estado = 'PENDIENTE'`,
    );

    for (const [codigo, nombre, maxActivos, cocheras, precio, orden] of PLANES)
      await runner.query(
        `INSERT INTO planes (codigo, nombre, "maxActivos", "incluyeCocheras", "precioMensual", orden)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (codigo) DO NOTHING`,
        [codigo, nombre, maxActivos, cocheras, precio, orden],
      );

    // Las empresas que ya existen quedan sin vencimiento (SIN_PLAN): nada se suspende solo hasta
    // que el super admin les asigne plan y fecha. Las que ya estaban suspendidas lo estaban a mano.
    await runner.query(`
      INSERT INTO suscripciones ("empresaId", "motivoSuspension", "suspendidaEl")
      SELECT id,
             CASE WHEN estado <> 'ACTIVA' THEN 'MANUAL' END,
             CASE WHEN estado <> 'ACTIVA' THEN now() END
      FROM empresas
      ON CONFLICT ("empresaId") DO NOTHING
    `);

    const [identity] = await runner.query('SELECT current_user AS name');
    const platform = `current_setting('parking.platform', true) = 'yes'`;
    const scope = `"empresaId" = NULLIF(current_setting('parking.empresa', true), '')::uuid`;
    for (const table of [
      'suscripciones',
      'suscripcion_playas',
      'facturas_saas',
    ]) {
      await runner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await runner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await runner.query(`DROP POLICY IF EXISTS parking_system ON ${table}`);
      await runner.query(`DROP POLICY IF EXISTS parking_isolation ON ${table}`);
      await runner.query(
        `CREATE POLICY parking_system ON ${table} TO ${quote(identity.name)} USING (true) WITH CHECK (true)`,
      );
      await runner.query(
        `CREATE POLICY parking_isolation ON ${table} TO parking_scoped USING (${platform} OR (${scope}))`,
      );
      await runner.query(`GRANT SELECT ON ${table} TO parking_scoped`);
    }
    // El catálogo es el mismo para todos: sin RLS, solo lectura.
    await runner.query('GRANT SELECT ON planes TO parking_scoped');
  }

  async down(runner: QueryRunner) {
    await runner.query('DROP TABLE IF EXISTS facturas_saas');
    await runner.query('DROP TABLE IF EXISTS suscripcion_playas');
    await runner.query('DROP TABLE IF EXISTS suscripciones');
    await runner.query('DROP TABLE IF EXISTS planes');
  }

  /** Descarta la versión sin uso de una tabla; si tiene filas, la guarda con otro nombre. */
  private async retirarFormaVieja(
    runner: QueryRunner,
    tabla: string,
    columnaVieja: string,
  ) {
    const [vieja] = await runner.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
      [tabla, columnaVieja],
    );
    if (!vieja) return;
    const [{ filas }] = await runner.query(
      `SELECT COUNT(*)::int AS filas FROM ${quote(tabla)}`,
    );
    if (filas === 0) await runner.query(`DROP TABLE ${quote(tabla)} CASCADE`);
    else
      await runner.query(
        `ALTER TABLE ${quote(tabla)} RENAME TO ${quote(`${tabla}_anterior`)}`,
      );
  }
}
