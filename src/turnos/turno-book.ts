import { EntityManager } from 'typeorm';
import { operationContext, operationNow } from 'src/common/operation-context';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ConflictException } from '@nestjs/common';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { Turno } from './entities/turno.entity';
import { TurnoPayment } from './entities/turno-payment.entity';
import { tenantContext } from 'src/tenancy/tenant-context';
import { exigirCobro } from 'src/tenancy/modalidad';
dayjs.extend(utc);
dayjs.extend(timezone);
export const SHIFT_TZ = 'America/Argentina/Buenos_Aires';
export const externalPayment = new AsyncLocalStorage<{ userId: string | null; at: Date; medio: 'QR' | 'ALIAS' }>();

// Una acreditación tardía conserva el operador y el tramo que inició el cobro.
export async function paymentShift(m: EntityManager, userId?: string) {
  const original = externalPayment.getStore();
  if (!original) return operatorShift(m, userId);
  await rolloverShifts(m);
  if (!original.userId) return null;
  return m.getRepository(Turno).createQueryBuilder('t')
    .where('t.usuarioAperturaId = :user AND t.fechaApertura <= :at AND (t.fechaCierre IS NULL OR t.fechaCierre > :at)', { user: original.userId, at: original.at })
    .orderBy('t.fechaApertura', 'DESC').getOne();
}

export function salaryWithdrawal(available: number, reserve: number, salary: number) {
  return salary > 0 && available - reserve >= salary ? salary : 0;
}

export async function exitCount(m: EntityManager, id: string) {
  const [row] = await m.query(`SELECT ((SELECT COUNT(*) FROM ticket_registrations WHERE "exitTurnoId"=$1)
    + (SELECT COUNT(*) FROM ticket_registration_for_days WHERE "exitTurnoId"=$1 AND retired=true))::int AS total`, [id]);
  return Number(row.total);
}

export async function occupancyAt(m: EntityManager, at: Date) {
  const [row] = await m.query(`SELECT (
    (SELECT COUNT(*) FROM ticket_registrations WHERE
      (("entryDay"::date + COALESCE("entryTime"::time, '00:00'::time)) AT TIME ZONE $2) < $1
      AND ("departureTime" IS NULL OR (("departureDay"::date + "departureTime"::time) AT TIME ZONE $2) >= $1)) +
    (SELECT COUNT(*) FROM ticket_registration_for_days WHERE "createdAt" < $1
      AND ("retiredAt" >= $1 OR ("retiredAt" IS NULL AND COALESCE(retired, false) = false)))
    )::int AS total`, [at, SHIFT_TZ]);
  return Number(row.total);
}

export async function physicalCash(m: EntityManager, sessionId: string, at = new Date()) {
  const [row] = await m.query(`SELECT s."fondoInicial"
    + COALESCE((SELECT SUM(c.amount) FROM cash_entries c JOIN turnos t ON t.id = c."turnoId" WHERE t."cashSessionId" = s.id AND c."createdAt" < $2),0)
    + COALESCE((SELECT SUM(v.amount) FROM cash_session_movements v WHERE v."sesionId" = s.id AND v."createdAt" < $2),0) AS total
    FROM cash_sessions s WHERE s.id = $1`, [sessionId, at]);
  return Number(row.total);
}

// El tramo que sigue al corte copia las referencias del turno cortado (operador, caja, sesión), que
// ya se validaron al abrirlo. La revisión de referencias de la base las vuelve a mirar con el
// alcance de quien dispara el corte (el cron o cualquier operador de la playa), y el operador que
// abrió puede no ser visible ahí: un super admin que trabajó en la playa no pertenece a la empresa.
// Así el corte fallaba cada minuto desde las 00:00 y con él la caja de toda la playa (12/11/2026).
// Solo esta inserción se hace sin esa revisión, y solo dentro de la playa del alcance.
async function referenciasDelCorte<T>(m: EntityManager, playaId: string | null, insertar: () => Promise<T>): Promise<T> {
  const [{ playa, plataforma }] = await m.query(
    `SELECT current_setting('parking.playa', true) AS playa, current_setting('parking.platform', true) AS plataforma`);
  if (!playa || plataforma === 'yes' || !m.queryRunner?.isTransactionActive) return insertar();
  if (playa !== playaId) throw new ConflictException('El turno a cortar no es de esta playa.');
  await m.query(`SELECT set_config('parking.platform', 'yes', true)`);
  // Si la inserción falla, la transacción se revierte y con ella este ajuste (es local a la
  // transacción): no hace falta restaurarlo, y hacerlo taparía el error real.
  const resultado = await insertar();
  await m.query(`SELECT set_config('parking.platform', $1, true)`, [plataforma ?? 'no']);
  return resultado;
}

// Llamar dentro de la transacción del cobro/cierre. El cron y las peticiones usan el mismo
// bloqueo: aunque el servidor haya estado apagado, cada operación encuentra el tramo correcto.
export async function rolloverShifts(m: EntityManager, now = new Date()) {
  await m.query('SELECT pg_advisory_xact_lock(718904)');
  const today = dayjs(now).tz(SHIFT_TZ).startOf('day').toDate();
  const repo = m.getRepository(Turno);
  const open = await repo.createQueryBuilder('t').leftJoinAndSelect('t.usuarioApertura', 'u')
    .where("t.estado = 'ABIERTO' AND t.cashSessionId IS NOT NULL AND t.fechaApertura < :today", { today }).getMany();
  for (let turno of open) {
    let boundary = dayjs(turno.fechaApertura).tz(SHIFT_TZ).startOf('day').add(1, 'day');
    while (boundary.toDate() <= now) {
      const end = boundary.toDate();
      const vehicles = await occupancyAt(m, end);
      const balance = await physicalCash(m, turno.cashSessionId, end);
      await repo.update(turno.id, { estado: 'CERRADO', fechaCierre: end, cierreAutomatico: true,
        cierreCaja: false, vehiculosFin: vehicles, saldoAlCorte: balance, salidasRegistradas: await exitCount(m, turno.id) });
      const anterior = turno;
      turno = await referenciasDelCorte(m, anterior.playaId, () => repo.save(repo.create({ nombre: anterior.nombre, playaId: anterior.playaId,
        usuarioAperturaId: anterior.usuarioAperturaId, cajaId: anterior.cajaId, cashSessionId: anterior.cashSessionId,
        cashVersion: 2, fechaApertura: end, fechaOperativa: boundary.format('YYYY-MM-DD'),
        fondoInicial: 0, fondoRecibido: 0, continuacionDeId: anterior.id, jornadaId: anterior.jornadaId ?? anterior.id,
        sueldoPrevisto: anterior.sueldoPrevisto, vehiculosInicio: vehicles, saldoAlCorte: balance, estado: 'ABIERTO' })));
      boundary = boundary.add(1, 'day');
    }
  }
}

// Los cortes automáticos no son arqueos: se completan con hechos ocurridos sin conexión.
// Un cierre contado nunca se modifica al sincronizar.
export async function refreshAutomaticCuts(m: EntityManager, occurredAt: Date) {
  const repo = m.getRepository(Turno);
  const cuts = await repo.createQueryBuilder('t')
    .where('t.cierreAutomatico = true AND t.fechaCierre > :at', { at: occurredAt }).getMany();
  for (const cut of cuts) {
    const vehicles = await occupancyAt(m, cut.fechaCierre);
    const balance = await physicalCash(m, cut.cashSessionId, cut.fechaCierre);
    await repo.update(cut.id, { vehiculosFin: vehicles, saldoAlCorte: balance, salidasRegistradas: await exitCount(m, cut.id) });
    await repo.update({ continuacionDeId: cut.id }, { vehiculosInicio: vehicles });
    await repo.update({ continuacionDeId: cut.id, estado: 'ABIERTO' }, { saldoAlCorte: balance });
  }
}

export async function offlineShift(m: EntityManager, id: string, userId: string, at: Date) {
  await rolloverShifts(m);
  const initial = await m.getRepository(Turno).findOne({ where: { id, usuarioApertura: { id: userId } } });
  if (!initial) throw new ConflictException('El turno capturado no pertenece al operador.');
  const root = initial.jornadaId ?? initial.id;
  const active = await m.getRepository(Turno).createQueryBuilder('t')
    .where("(t.id=:root OR t.jornadaId=:root) AND t.estado='ABIERTO'", { root }).getOne();
  if (!active) throw new ConflictException('La jornada ya terminó. Conservá el cobro pendiente para revisar el arqueo.');
  const segment = await m.getRepository(Turno).createQueryBuilder('t')
    .where('(t.id=:root OR t.jornadaId=:root) AND t.fechaApertura <= :at AND (t.fechaCierre IS NULL OR t.fechaCierre > :at)', { root, at }).getOne();
  if (!segment) throw new ConflictException('La operación no pertenece al horario de esta jornada.');
  return segment;
}

export async function operatorShift(m: EntityManager, userId = tenantContext.getStore()?.userId) {
  const replay = operationContext.getStore();
  if (replay) return replay.shiftId ? m.getRepository(Turno).findOneBy({ id: replay.shiftId, usuarioApertura: { id: userId } }) : null;
  await rolloverShifts(m);
  if (!userId) return null;
  return m.getRepository(Turno).findOne({ where: { usuarioApertura: { id: userId }, estado: 'ABIERTO' } });
}

export async function recordDigital(m: EntityManager, amount: number, method: string | null | undefined,
  reference: string, userId?: string | null, turnoId?: string | null) {
  if (!amount || !method || method === 'CASH') return;
  // Ingreso digital (o su reversión): en una playa gratuita no hay cobros que registrar.
  await exigirCobro(m);
  const shift = turnoId === undefined ? await paymentShift(m, userId ?? undefined) : null;
  await m.getRepository(TurnoPayment).save({ ...(operationContext.getStore() ? { createdAt: operationNow() } : {}), amount, medio: externalPayment.getStore()?.medio ?? (method === 'MERCADOPAGO' ? 'QR' : method),
    referencia: reference, turnoId: turnoId === undefined ? shift?.id ?? null : turnoId });
}

export async function reverseDigital(m: EntityManager, amount: number, method: string | null | undefined,
  originalReference: string, reference: string, userId?: string) {
  if (!method || method === 'CASH') return;
  const original = await m.getRepository(TurnoPayment).findOne({ where: { referencia: originalReference }, order: { createdAt: 'DESC' } });
  await recordDigital(m, -amount, original?.medio ?? method, reference, userId);
}

export async function shiftSummary(m: EntityManager, turno: Turno) {
  // No inventar detalles de retiros o vehículos que el esquema anterior no registraba.
  if (!turno.fechaOperativa) return null;
  // Lo devuelto en efectivo de un anticipo se descuenta de lo cobrado: es el mismo cobro que
  // terminó siendo menor, no un retiro. Las demás devoluciones siguen aparte.
  const [cash] = await m.query(`SELECT COALESCE(SUM(amount),0) AS neto,
    COALESCE(SUM(GREATEST(amount,0)) FILTER (WHERE categoria = 'COBRO'),0)
      + COALESCE(SUM(amount) FILTER (WHERE categoria = 'DEVOLUCION_ANTICIPO'),0) AS cobros,
    COALESCE(-SUM(amount) FILTER (WHERE categoria = 'GASTO'),0) AS gastos,
    COALESCE(SUM(amount) FILTER (WHERE categoria = 'INGRESO'),0) AS ingresos,
    COALESCE(-SUM(amount) FILTER (WHERE categoria = 'COBRO' AND amount < 0),0) AS devoluciones
    FROM cash_entries WHERE "turnoId" = $1`, [turno.id]);
  const payments = await m.query(`SELECT medio, SUM(amount) AS total FROM (
    SELECT CASE WHEN metodo = 'MERCADOPAGO' THEN 'QR'
      WHEN referencia LIKE 'Transferencia MercadoPago %' THEN 'ALIAS' ELSE metodo::text END AS medio, monto AS amount
      FROM movimientos WHERE "turnoId" = $1 AND tipo NOT IN ('CORTESIA', 'DESCUENTO') AND metodo <> 'CASH'
    UNION ALL SELECT medio, amount FROM turno_payments WHERE "turnoId" = $1
    ) p GROUP BY medio`, [turno.id]);
  const totals = Object.fromEntries(payments.map(p => [p.medio, Number(p.total)]));
  const exits = turno.salidasRegistradas ?? await exitCount(m, turno.id);
  const movements = await m.query(`SELECT v.id, v.tipo, v.amount, v.motivo, v."createdAt", v."usuarioId",
    trim(concat(u."firstName", ' ', u."lastName")) AS operador
    FROM cash_session_movements v LEFT JOIN users u ON u.id=v."usuarioId"
    WHERE v."turnoId"=$1 OR (v."turnoId" IS NULL AND v."sesionId"=$2 AND $3)
    ORDER BY v."createdAt"`, [turno.id, turno.cashSessionId, turno.cierreCaja]);
  const withdrawals = movements.filter(v => v.tipo === 'RETIRO').reduce((n, v) => n - v.amount, 0);
  const endWithdrawal = turno.cierreCaja ? Math.max(0, (turno.efectivoRetirado ?? 0) - turno.sueldoRetirado) : 0;
  return { efectivoCobrado: Number(cash.cobros), efectivoNeto: Number(cash.neto),
    ingresosVarios: Number(cash.ingresos), gastosEfectivo: Number(cash.gastos), devolucionesEfectivo: Number(cash.devoluciones),
    mercadoPagoAlias: totals.ALIAS ?? 0, mercadoPagoQr: totals.QR ?? 0, transferencias: totals.TRANSFER ?? 0,
    sueldoRetirado: turno.sueldoRetirado, retirosRecaudacion: withdrawals + endWithdrawal,
    totalRetirado: Number(cash.gastos) + Number(cash.devoluciones) + turno.sueldoRetirado + withdrawals + endWithdrawal,
    salidas: exits,
    vehiculosInicio: turno.vehiculosInicio, vehiculosFin: turno.vehiculosFin,
    efectivoParaSiguiente: turno.efectivoParaSiguiente, movimientos: movements,
    alcanceCaja: turno.cierreCaja ? 'Arqueo de toda la caja compartida' : null };
}
