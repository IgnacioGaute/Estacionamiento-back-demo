import { MigrationInterface, QueryRunner } from 'typeorm';

// La primera versión de las cuentas emitía la factura del mes siguiente 7 días antes del
// vencimiento. Ahora se emite el mismo día en que vence (al terminar la prueba o lo pagado), así
// que una pendiente con fecha futura sobra: la empresa la vería como deuda antes de tiempo. Se
// anula con el motivo; la tarea diaria la vuelve a emitir el día que corresponde. Idempotente.
export class FacturasAnticipadas1790000023000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`
      UPDATE facturas_saas
      SET estado = 'ANULADA',
          "motivoAnulacion" = 'Emitida antes del vencimiento: se vuelve a emitir el día que vence.',
          "anuladaEl" = now()
      WHERE estado = 'PENDIENTE'
        AND desde > (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
    `);
  }

  async down() {
    // Nada que deshacer: las anuladas se vuelven a emitir solas cuando corresponde.
  }
}
