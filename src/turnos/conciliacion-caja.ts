import { EntityManager } from 'typeorm';
import { Turno } from './entities/turno.entity';
import { CashSession } from './entities/cash-session.entity';

// Lo que conviene mirar cuando la caja no coincide. No son errores: son los casos que, en los
// faltantes que se revisaron (MLT748, 12/11/2026), explicaban la diferencia o la escondían.
export type MotivoRevision = 'DESCUENTO_TOTAL' | 'COBRO_SIN_TIEMPO' | 'REINGRESO';
export type EstadiaParaRevisar = { id: string; patente: string; motivo: MotivoRevision; detalle: string; salida: string };

const plata = (n: number) => '$' + Math.round(n).toLocaleString('es-AR');

// Explica el saldo con el mismo libro físico que usa el cierre. Incluye a todos los
// participantes de la sesión; los medios digitales nunca entran en este libro.
export async function conciliacionCaja(manager: EntityManager, turno: Turno) {
  if (turno.cashVersion !== 2) return null;
  const session = turno.cashSessionId
    ? await manager.getRepository(CashSession).findOneByOrFail({ id: turno.cashSessionId }) : null;
  const movimientos: { id: string; amount: number; concepto: string; operador: string; fecha: Date }[] = await manager.query(`
    SELECT c.id, c.amount, c.description AS concepto, t.nombre AS operador, c."createdAt" AS fecha
    FROM cash_entries c JOIN turnos t ON t.id = c."turnoId"
    WHERE ($1::uuid IS NOT NULL AND t."cashSessionId" = $1) OR ($1::uuid IS NULL AND t.id = $2)
    UNION ALL
    SELECT v.id, v.amount, v.motivo AS concepto,
      COALESCE(NULLIF(trim(concat(u."firstName", ' ', u."lastName")), ''), 'Responsable no disponible') AS operador,
      v."createdAt" AS fecha
    FROM cash_session_movements v LEFT JOIN users u ON u.id = v."usuarioId"
    WHERE v."sesionId" = $1
    ORDER BY fecha, id`, [turno.cashSessionId ?? null, turno.id]);
  const fondoInicial = session?.fondoInicial ?? turno.fondoInicial;
  const ingresos = movimientos.reduce((sum, m) => sum + Math.max(0, m.amount), 0);
  const egresos = movimientos.reduce((sum, m) => sum + Math.max(0, -m.amount), 0);
  // Los conteos de relevo: cuánto había cuando alguien se sumó o dejó la caja compartida.
  const conteos: { id: string; momento: 'INGRESO' | 'SALIDA'; contado: number; esperado: number; diferencia: number; motivo: string | null; operador: string; fecha: Date }[] =
    turno.cashSessionId ? await manager.query(`
      SELECT k.id, k.momento, k.contado, k.esperado, k.diferencia, k.motivo, k."createdAt" AS fecha,
        COALESCE(NULLIF(trim(concat(u."firstName", ' ', u."lastName")), ''), 'Responsable no disponible') AS operador
      FROM cash_session_counts k LEFT JOIN users u ON u.id = k."usuarioId"
      WHERE k."sesionId" = $1 ORDER BY k."createdAt", k.id`, [turno.cashSessionId]) : [];
  return { fondoInicial, ingresos, egresos, esperado: fondoInicial + ingresos - egresos, movimientos, conteos, paraRevisar: await estadiasParaRevisar(manager, turno) };
}

// Las salidas de los turnos de esta caja que conviene revisar antes de explicar una diferencia:
// descuento de todo el importe, un cobro de una estadía de 0 a 2 minutos y una patente que vuelve
// a entrar enseguida después de salir (una salida cargada como entrada, un auto cobrado dos veces).
async function estadiasParaRevisar(manager: EntityManager, turno: Turno): Promise<EstadiaParaRevisar[]> {
  const filas: { id: string; patente: string | null; minutos: number; cobrado: string; descuento: string; salida: string; reingreso: string | null }[] = await manager.query(`
    WITH turnos_caja AS (
      SELECT id FROM turnos WHERE ($1::uuid IS NOT NULL AND "cashSessionId" = $1) OR id = $2
    ), estadias AS (
      SELECT r.id, r."licensePlateOriginal" AS patente, r."licensePlateNormalized" AS normalizada,
        (r."entryDay" + r."entryTime") AS entrada, (r."departureDay" + r."departureTime") AS salida,
        COALESCE(SUM(m.monto) FILTER (WHERE m.tipo IN ('ANTICIPO', 'SALDO', 'AJUSTE')), 0) AS cobrado,
        COALESCE(SUM(m.monto) FILTER (WHERE m.tipo = 'DESCUENTO'), 0) AS descuento
      FROM ticket_registrations r LEFT JOIN movimientos m ON m."ticketRegistrationId" = r.id
      WHERE r."exitTurnoId" IN (SELECT id FROM turnos_caja) AND r."departureDay" IS NOT NULL AND r."departureTime" IS NOT NULL
      GROUP BY r.id
    )
    SELECT e.id, e.patente, EXTRACT(EPOCH FROM (e.salida - e.entrada)) / 60 AS minutos, e.cobrado, e.descuento,
      to_char(e.salida, 'HH24:MI') AS salida,
      (SELECT to_char(o."departureDay" + o."departureTime", 'HH24:MI') FROM ticket_registrations o
        WHERE o.id <> e.id AND e.normalizada IS NOT NULL AND o."licensePlateNormalized" = e.normalizada
          AND o."departureDay" IS NOT NULL AND o."departureTime" IS NOT NULL
          AND (o."departureDay" + o."departureTime") BETWEEN e.entrada - interval '15 minutes' AND e.entrada + interval '1 minute'
        ORDER BY o."departureDay" DESC, o."departureTime" DESC LIMIT 1) AS reingreso
    FROM estadias e
    ORDER BY e.salida`, [turno.cashSessionId ?? null, turno.id]);
  const lista: EstadiaParaRevisar[] = [];
  for (const f of filas) {
    const patente = f.patente || 'Sin patente';
    const cobrado = Number(f.cobrado);
    const descuento = Number(f.descuento);
    const minutos = Math.max(0, Math.round(Number(f.minutos)));
    if (descuento > 0 && cobrado <= 0)
      lista.push({ id: f.id, patente, motivo: 'DESCUENTO_TOTAL', salida: f.salida, detalle: `Salió ${f.salida} sin cobro: descuento de ${plata(descuento)}.` });
    if (cobrado > 0 && minutos <= 2)
      lista.push({ id: f.id, patente, motivo: 'COBRO_SIN_TIEMPO', salida: f.salida, detalle: `Estadía de ${minutos} min cobrada ${plata(cobrado)}.` });
    if (f.reingreso)
      lista.push({ id: f.id, patente, motivo: 'REINGRESO', salida: f.salida, detalle: `Volvió a entrar después de salir a las ${f.reingreso}.` });
  }
  return lista;
}
