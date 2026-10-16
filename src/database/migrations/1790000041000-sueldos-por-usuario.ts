import { MigrationInterface, QueryRunner } from 'typeorm';

export class SueldosPorUsuario1790000041000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query('ALTER TABLE ticket_schedule_settings ADD COLUMN IF NOT EXISTS "sueldosPorUsuario" jsonb');
    // Conserva el importe anterior para los usuarios que ya podían operar en esa playa.
    // Los usuarios nuevos quedan sin retiro hasta que administración lo configure.
    await r.query(`UPDATE ticket_schedule_settings s SET "sueldosPorUsuario" = COALESCE((
      SELECT jsonb_agg(jsonb_build_object('usuarioId', u.id, 'importe', s."sueldoPorTurno") ORDER BY u.id)
      FROM users u JOIN playas p ON p.id = s."playaId" AND p."empresaId" = u."empresaId"
      WHERE u."deletedAt" IS NULL AND s."sueldoPorTurno" > 0
        AND (u.role = 'ADMIN' OR (u.role = 'USER' AND EXISTS (
          SELECT 1 FROM usuario_playas up WHERE up."usuarioId" = u.id AND up."playaId" = p.id)))
    ), '[]'::jsonb) WHERE s."sueldosPorUsuario" IS NULL`);
    await r.query(`ALTER TABLE ticket_schedule_settings ALTER COLUMN "sueldosPorUsuario" SET DEFAULT '[]'::jsonb, ALTER COLUMN "sueldosPorUsuario" SET NOT NULL`);
  }

  async down() { throw new Error('Se conservan los sueldos configurados por usuario.'); }
}
