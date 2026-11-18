import { MigrationInterface, QueryRunner } from 'typeorm';

// Los avisos se acumulaban: un descuento con motivo pesaba lo mismo que un faltante de caja. Ahora
// solo los «para revisar» quedan pendientes y suman al número; los informativos se consultan en la
// cartelera. Los del equipo (sin sourceKey) siguen siendo para revisar.
// Los automáticos existentes se clasifican con la misma regla que usa cada operación al publicarlos.
export class AvisosParaRevisar1790000055000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query('ALTER TABLE notes ADD COLUMN IF NOT EXISTS "paraRevisar" boolean NOT NULL DEFAULT true');
    await r.query(`UPDATE notes SET "paraRevisar" = false WHERE "sourceKey" IS NOT NULL AND (
      origin IN ('Descuento de vehículo', 'Cobro a inquilino', 'Saldo inicial de inquilino', 'Recargo de cuenta',
        'Bonificación de cuenta', 'Retiro de caja', 'Aporte de caja')
      OR origin LIKE 'Comentario de %')`);
    // Cierre: para revisar si hubo diferencia, un conteo corregido o lo cerró administración.
    await r.query(`UPDATE notes n SET "paraRevisar" = false FROM turnos t
      WHERE n."sourceKey" = 'cierre:' || t.id::text AND COALESCE(t.diferencia, 0) = 0 AND t."motivoCierreForzado" IS NULL
        AND (t."primerConteo" IS NULL OR t."efectivoContado" IS NULL OR t."primerConteo" = t."efectivoContado")`);
    // Apertura: para revisar si lo recibido no coincidió con lo que dejó el anterior.
    await r.query(`UPDATE notes n SET "paraRevisar" = false FROM cash_sessions s
      WHERE n."sourceKey" = 'apertura:' || s.id::text AND COALESCE(s."diferenciaApertura", 0) = 0`);
  }

  async down(r: QueryRunner) {
    await r.query('ALTER TABLE notes DROP COLUMN IF EXISTS "paraRevisar"');
  }
}
