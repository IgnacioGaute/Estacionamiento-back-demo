import { MigrationInterface, QueryRunner } from 'typeorm';
export class ComisionesMediosMp1790000033000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query('ALTER TABLE empresas ADD COLUMN IF NOT EXISTS "comisionesMp" jsonb');
    await r.query(`UPDATE empresas SET "comisionesMp" = jsonb_build_object(
      'qrSaldo', CASE WHEN "comisionQrPorcentaje" > 0 THEN "comisionQrPorcentaje" ELSE 0.968 END,
      'qrDebito', CASE WHEN "comisionQrPorcentaje" > 0 THEN "comisionQrPorcentaje" ELSE 1.6335 END,
      'qrCredito', CASE WHEN "comisionQrPorcentaje" > 0 THEN "comisionQrPorcentaje" ELSE 7.2479 END,
      'aliasSaldo', "comisionTransferenciaPorcentaje", 'aliasDebito', "comisionTransferenciaPorcentaje",
      'aliasCredito', CASE WHEN "comisionTransferenciaPorcentaje" > 0 THEN "comisionTransferenciaPorcentaje" ELSE NULL END)
      WHERE "comisionesMp" IS NULL`);
    await r.query('ALTER TABLE cobros_mercadopago ADD COLUMN IF NOT EXISTS "paymentTypeId" varchar(40)');
    await r.query('ALTER TABLE transferencias_recibidas ADD COLUMN IF NOT EXISTS "paymentTypeId" varchar(40)');
    const [role] = await r.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'parking_scoped') AS present");
    if (role.present) await r.query('GRANT UPDATE ("comisionesMp", "updatedAt") ON empresas TO parking_scoped');
  }
  async down() { throw new Error('Conservar la clasificación de los pagos y las tasas configuradas.'); }
}
