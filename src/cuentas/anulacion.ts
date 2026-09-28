import { EntityManager } from 'typeorm';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { CuentaMovimiento } from './entities/cuenta-movimiento.entity';
import { hoy, mesLargo } from './libro';

dayjs.extend(utc);
dayjs.extend(timezone);

// Qué se puede anular y hasta cuándo. Anular sirve para un error de carga reciente: el asiento
// sale de la vista como si no hubiera existido. Pasado el plazo, lo que corresponde es un
// ajuste, que deja a la vista tanto la deuda como su corrección. Borrar deuda sin rastro es
// justo lo que la cuenta corriente tiene que impedir.
//
// La misma regla la usan la anulación y el estado de cuenta (que la manda a la pantalla), así
// el botón nunca ofrece algo que el servidor después rechaza.

const TZ = 'America/Argentina/Buenos_Aires';

export type Anulable = { ok: true } | { ok: false; code: string; motivo: string };

export type ContextoAnulacion = {
  mes: string;
  hoy: string;
  turnosAbiertos: Set<string>;
  anulados: Set<string>;
  // receiptId → asiento que creó el recibo (el primero por secuencia).
  origenes: Map<string, string>;
  recibosConPagos: Set<string>;
};

// `filas`: todos los asientos del inquilino. Se reciben para no leerlos dos veces.
export async function contextoAnulacion(
  m: EntityManager,
  customerId: string,
  filas: CuentaMovimiento[],
): Promise<ContextoAnulacion> {
  const origenes = new Map<string, string>();
  for (const f of [...filas].sort((a, b) => Number(a.sequence) - Number(b.sequence)))
    if (f.receiptId && !origenes.has(f.receiptId)) origenes.set(f.receiptId, f.id);

  const turnos: { id: string }[] = await m.query(`SELECT id FROM turnos WHERE estado = 'ABIERTO'`);
  // Una imputación de saldo a favor (CREDIT) no es un pago: se deshace sola al anular.
  const conPagos: { receiptId: string }[] = await m.query(
    `SELECT DISTINCT rp."receiptId"
     FROM receipt_payments rp JOIN receipts r ON r.id = rp."receiptId"
     WHERE r."customerId" = $1 AND rp."paymentType" <> 'CREDIT'`,
    [customerId],
  );
  return {
    mes: hoy().slice(0, 7),
    hoy: hoy(),
    turnosAbiertos: new Set(turnos.map((t) => t.id)),
    anulados: new Set(filas.filter((f) => f.anulaId).map((f) => f.anulaId!)),
    origenes,
    recibosConPagos: new Set(conPagos.map((r) => r.receiptId)),
  };
}

export function reglaAnulacion(fila: CuentaMovimiento, ctx: ContextoAnulacion): Anulable {
  const no = (code: string, motivo: string): Anulable => ({ ok: false, code, motivo });
  const detalle = (fila.detalle ?? {}) as { migrado?: boolean; turnoId?: string | null };

  if (fila.tipo === 'ANULACION') return no('ES_ANULACION', 'Una anulación no se anula: si hace falta, cargá un ajuste.');
  if (ctx.anulados.has(fila.id)) return no('YA_ANULADO', 'Ya estaba anulado.');
  if (detalle.migrado)
    return no('HISTORIA_MIGRADA', 'Viene del sistema anterior a la cuenta corriente: se corrige con un ajuste.');

  // Un cobro con QR lo confirmó MercadoPago: la plata entró de verdad, no hay error de carga que
  // anular. Si hay que devolverla, es una devolución.
  if (fila.tipo === 'PAGO' && fila.metodo === 'MERCADOPAGO')
    return no('PAGO_MERCADOPAGO', 'Se acreditó por MercadoPago: la plata entró. Si hay que devolverla, registrá una devolución.');

  if (fila.tipo === 'PAGO' || fila.tipo === 'DEVOLUCION') {
    // El efectivo de un turno cerrado ya se contó y se entregó: moverlo ahora descuadraría la
    // caja de otro turno, que nunca lo tuvo. Pasado ese plazo, si la plata se devuelve de verdad
    // es una devolución (sale de caja o del banco), no una anulación ni un ajuste.
    const que = fila.tipo === 'PAGO' ? 'Se cobró' : 'Se devolvió';
    const salida =
      fila.tipo === 'PAGO'
        ? 'Si hay que devolverle la plata, registrá una devolución; si el cobro no correspondía, corregí la cuenta con un ajuste.'
        : 'Si el inquilino reintegra la plata, registralo como un pago.';
    if (detalle.turnoId)
      return ctx.turnosAbiertos.has(detalle.turnoId)
        ? { ok: true }
        : no('TURNO_CERRADO', `${que} en un turno que ya cerró y su efectivo ya se rindió. ${salida}`);
    return String(fila.fecha).slice(0, 10) === ctx.hoy
      ? { ok: true }
      : no('FUERA_DE_PLAZO', `Solo se anula en el mismo día. ${salida}`);
  }

  const mesDeCarga = dayjs(fila.createdAt).tz(TZ).format('YYYY-MM');
  if (mesDeCarga !== ctx.mes)
    return no(
      'FUERA_DE_PLAZO',
      `Se cargó en ${mesLargo(mesDeCarga)}: pasado el mes, se corrige con ${fila.importe > 0 ? 'una bonificación' : 'un recargo'}.`,
    );
  if (fila.importe > 0 && fila.receiptId && ctx.origenes.get(fila.receiptId) === fila.id && ctx.recibosConPagos.has(fila.receiptId))
    return no('RECIBO_CON_PAGOS', 'El recibo tiene pagos: anulá primero esos pagos.');
  return { ok: true };
}
