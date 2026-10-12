import { MigrationInterface, QueryRunner } from 'typeorm';

export class AvisosNotasExistentes1790000040000 implements MigrationInterface {
  async up(r: QueryRunner) {
    // Conserva fecha y autor conocidos. Los comentarios de clientes anteriores no
    // guardaban autor: quedan sin atribuir en lugar de adjudicárselos a un operador.
    await r.query(`WITH fuentes AS (
      SELECT 'cierre:' || t.id AS key, t."playaId", t."usuarioCierreId" AS autor,
        'Cierre de turno' AS origen, 'TURNO' AS tipo, t.id AS referencia,
        concat_ws(E'\\n', nullif(btrim(t.observaciones), ''),
          CASE WHEN nullif(btrim(t."motivoCierreForzado"), '') IS NOT NULL
            THEN 'Cierre por administrador: ' || btrim(t."motivoCierreForzado") END) AS texto,
        concat_ws(' · ', coalesce(c.nombre, 'Caja'), t.nombre) AS contexto,
        coalesce(t."fechaCierre", t."fechaApertura")::timestamptz AS fecha
      FROM turnos t LEFT JOIN cash_registers c ON c.id = t."cajaId"
      WHERE t.estado = 'CERRADO' AND NOT t."cierreAutomatico"
      UNION ALL
      SELECT 'apertura:' || s.id, s."playaId", t."usuarioAperturaId",
        'Apertura de caja', 'TURNO', t.id, s."motivoApertura",
        concat_ws(' · ', c.nombre, t.nombre), s."fechaApertura"
      FROM cash_sessions s JOIN cash_registers c ON c.id = s."cajaId"
      JOIN LATERAL (SELECT * FROM turnos WHERE "cashSessionId" = s.id ORDER BY "fechaApertura", id LIMIT 1) t ON true
      UNION ALL
      SELECT 'caja-movimiento:' || m.id, m."playaId", m."usuarioId",
        CASE WHEN m.tipo = 'RETIRO' THEN 'Retiro de caja' ELSE 'Aporte de caja' END,
        'CAJA', m."sesionId", m.motivo, c.nombre, m."createdAt"
      FROM cash_session_movements m JOIN cash_sessions s ON s.id = m."sesionId"
      JOIN cash_registers c ON c.id = s."cajaId" WHERE m.tipo IN ('RETIRO', 'APORTE')
      UNION ALL
      SELECT 'entrada:' || t.id, t."playaId", null::uuid, 'Entrada con patente ya activa',
        'TICKET', t.id, t."duplicatePlateOverrideReason", t."licensePlateOriginal", t."createdAt"::timestamptz
      FROM ticket_registrations t
      UNION ALL
      SELECT 'movimiento:' || m.id, m."playaId", m."usuarioId",
        CASE WHEN m.tipo::text IN ('DESCUENTO', 'CORTESIA') THEN 'Descuento de vehículo' ELSE 'Corrección de cobro' END,
        'TICKET', coalesce(m."ticketRegistrationId", m.id), m.motivo,
        coalesce(t."licensePlateOriginal", t."codeBarTicket", 'Vehículo'), m."fechaHora"
      FROM movimientos m LEFT JOIN ticket_registrations t ON t.id = m."ticketRegistrationId"
      UNION ALL
      SELECT 'cliente:' || c.id || ':comentario', c."playaId", null::uuid,
        CASE c."customerType" WHEN 'RENTER' THEN 'Comentario de inquilino'
          WHEN 'OWNER' THEN 'Comentario de propietario' ELSE 'Comentario de cliente particular' END,
        c."customerType"::text, c.id, c.comments, concat_ws(' ', c."lastName", c."firstName"), c."createdAt"::timestamptz
      FROM customers c
      UNION ALL
      SELECT CASE WHEN f.tipo = 'PAGO' THEN 'cuenta-pago:' || f.id
          WHEN f.tipo = 'SALDO_INICIAL' THEN 'saldo-inicial:' || f.id
          WHEN f.tipo = 'ANULACION' AND f.numero IS NOT NULL THEN 'cuenta-anulacion:' || f."customerId" || ':' || f.numero
          ELSE 'cuenta:' || f.id END,
        f."playaId", f."usuarioId",
        CASE f.tipo WHEN 'PAGO' THEN 'Cobro a inquilino' WHEN 'SALDO_INICIAL' THEN 'Saldo inicial de inquilino'
          WHEN 'ANULACION' THEN 'Anulación de cuenta' WHEN 'DEVOLUCION' THEN 'Devolución a inquilino'
          ELSE CASE WHEN f.importe > 0 THEN 'Recargo de cuenta' ELSE 'Bonificación de cuenta' END END,
        'CUENTA', f."customerId", f.motivo, concat_ws(' ', c."lastName", c."firstName"), f."createdAt"
      FROM cuenta_movimientos f JOIN customers c ON c.id = f."customerId"
      WHERE NOT coalesce((f.detalle->>'migrado')::boolean, false)
        AND (f.tipo NOT IN ('PAGO', 'SALDO_INICIAL') OR f.id IN (
          SELECT (array_agg(id ORDER BY sequence))[CASE WHEN tipo = 'PAGO' THEN 1 ELSE count(*)::int END]
          FROM cuenta_movimientos WHERE tipo IN ('PAGO', 'SALDO_INICIAL')
          GROUP BY "customerId", tipo, coalesce(numero, fecha::text || ':' || coalesce(motivo, ''))
        ))
    )
    INSERT INTO notes (id, "playaId", "userId", "sourceKey", origin, "sourceType", "sourceId", description, context, date, hours, "createdAt")
    SELECT gen_random_uuid(), "playaId", autor, key, origen, tipo, referencia, btrim(texto), contexto,
      (fecha AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,
      (fecha AT TIME ZONE 'America/Argentina/Buenos_Aires')::time, fecha
    FROM fuentes WHERE nullif(btrim(texto), '') IS NOT NULL
    ON CONFLICT ("sourceKey") DO NOTHING`);
  }
  async down() { throw new Error('Se conservan los avisos recuperados de operaciones anteriores.'); }
}
