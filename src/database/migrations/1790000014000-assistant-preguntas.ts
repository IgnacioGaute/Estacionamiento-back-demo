import { MigrationInterface, QueryRunner } from 'typeorm';

// Las preguntas que los operadores le hacen al asistente, para que el super admin vea qué se
// consulta y dónde conviene mejorar pantallas o ayuda. Se guarda la pregunta y su tema; la
// respuesta y los datos que consultó el modelo no.
//
// Es dato de una playa: mismo aislamiento que el resto de la operación. El asistente escribe
// desde la conexión con alcance (`parking_scoped`), así que sin su política no podría insertar;
// la pantalla de métricas lee con el rol dueño, que ve todas.
export class AssistantPreguntas1790000014000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query(`CREATE TABLE IF NOT EXISTS assistant_preguntas (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "playaId" uuid NOT NULL REFERENCES playas(id),
      "userId" uuid REFERENCES users(id),
      pregunta varchar(300) NOT NULL,
      clave varchar(300) NOT NULL,
      tema varchar(24) NOT NULL,
      respondida boolean NOT NULL DEFAULT false,
      "createdAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await r.query(
      'CREATE INDEX IF NOT EXISTS assistant_preguntas_playa_fecha ON assistant_preguntas ("playaId", "createdAt")',
    );
    await r.query('ALTER TABLE assistant_preguntas ENABLE ROW LEVEL SECURITY');
    await r.query('ALTER TABLE assistant_preguntas FORCE ROW LEVEL SECURITY');
    const [owner] = await r.query('SELECT current_user AS name');
    await r.query(
      `CREATE POLICY parking_system ON assistant_preguntas TO "${owner.name.replace(/"/g, '""')}" USING (true) WITH CHECK (true)`,
    );
    await r.query(
      `CREATE POLICY parking_isolation ON assistant_preguntas TO parking_scoped USING ("playaId" = NULLIF(current_setting('parking.playa', true), '')::uuid) WITH CHECK ("playaId" = NULLIF(current_setting('parking.playa', true), '')::uuid)`,
    );
    await r.query('GRANT SELECT, INSERT ON assistant_preguntas TO parking_scoped');
  }

  async down(r: QueryRunner) {
    await r.query('DROP TABLE IF EXISTS assistant_preguntas');
  }
}
