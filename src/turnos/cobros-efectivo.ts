import { EntityManager } from 'typeorm';
import { Turno } from './entities/turno.entity';

// El detalle de los cobros en efectivo de UN turno, para revisar un faltante desde el historial.
//
// La base es el libro físico del turno (cash_entries con su turnoId): es lo que recibió ese turno, y
// no se reparte por la estadía ni por la caja compartida. La conciliación (conciliacion-caja.ts)
// mira toda la sesión de caja, con todos los participantes; acá no se mezclan.
//
// Entra lo cobrado y lo devuelto en efectivo (categorías COBRO y DEVOLUCION_ANTICIPO). Los gastos e
// ingresos de «Varios» quedan afuera: el resumen del turno los muestra en sus propias líneas.
//
// cash_entries no guarda qué operación lo originó. Cada operación escribe su fila y la del efectivo
// en la misma transacción, y las dos toman la misma hora (now() es la hora de la transacción; sin
// conexión, las dos usan la hora real de la operación). Con esa hora se buscan las fuentes:
//   - movimientos de estadías en efectivo de este mismo turno (anticipo, saldo, ajuste o devolución:
//     cada medio de un pago mixto es su propio movimiento, así que solo entra la parte en efectivo;
//     las cortesías y descuentos no son plata y no entran);
//   - pagos, devoluciones y anulaciones en efectivo de cuentas de inquilinos;
//   - estadías por día, semana o mes cobradas en efectivo al registrarlas.
// Si lo encontrado suma exactamente lo que entró a la caja en ese momento, se muestran esas
// operaciones; si no (un pase marcado como pagado después, uno eliminado, un ajuste a mano de la
// caja), se muestra la entrada de caja tal cual, con su hora e importe, marcada «sin detalle». Así
// el total siempre es el efectivo registrado del turno y nunca se inventa una patente.
//
// `recibido` y `vuelto`: lo que el operador declaró que le entregaron y el vuelto que calculó el
// servidor, en los cobros de estadías y pases que lo guardan (ver movimientos/efectivo-recibido.ts).
// Son datos declarados que explican el cobro, no plata: no entran en ningún total. null cuando no se
// guardó (cobros anteriores, pendientes sin conexión viejos, inquilinos, ajustes): no se inventan.
export type ConceptoCobroEfectivo = 'ANTICIPO' | 'SALDO' | 'AJUSTE' | 'DEVOLUCION' | 'PAGO_INQUILINO' | 'DEVOLUCION_INQUILINO'
  | 'ANULACION_INQUILINO' | 'ESTADIA_PERIODO' | 'DEVOLUCION_ANTICIPO' | 'AJUSTE_CAJA' | 'COBRO' | 'CORRECCION';

export type CobroEfectivo = {
  id: string;
  fecha: string;
  concepto: ConceptoCobroEfectivo;
  // Patente, ticket o inquilino; null cuando la operación no tiene uno (no se inventa).
  identificacion: string | null;
  importe: number;
  sinDetalle: boolean;
  recibido: number | null;
  vuelto: number | null;
};

const PERIODOS: Record<string, string> = { DIA: 'día', SEMANA: 'semana', SEMANA_Y_DIA: 'semana y día', MES: 'mes', MES_Y_DIA: 'mes y día' };

export async function cobrosEfectivoTurno(manager: EntityManager, turno: Turno) {
  // La clave de la transacción: la hora con microsegundos, en UTC. Las fechas sin zona (los pases)
  // se guardaron con la zona de la sesión y se leen con esa misma zona.
  const clave = (columna: string) => `to_char(${columna} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
  const entradas: { id: string; amount: number; categoria: string; description: string; clave: string; fecha: Date }[] = await manager.query(`
    SELECT c.id, c.amount, c.categoria, c.description, ${clave('c."createdAt"')} AS clave, c."createdAt" AS fecha
    FROM cash_entries c
    WHERE c."turnoId" = $1 AND c.categoria IN ('COBRO', 'DEVOLUCION_ANTICIPO', 'CORRECCION') AND c.amount <> 0
    ORDER BY c."createdAt", c.id`, [turno.id]);
  if (!entradas.length) return resultado([]);
  const momentos = [...new Set(entradas.map((e) => e.clave))];

  const fuentes: (Omit<CobroEfectivo, 'sinDetalle' | 'importe' | 'fecha' | 'recibido' | 'vuelto'> & { importe: string | number; clave: string; fecha: Date; extra: string | null; recibido: number | string | null; vuelto: number | string | null })[] = await manager.query(`
    WITH momentos AS (SELECT unnest($2::text[]) AS clave)
    SELECT m.id::text AS id, ${clave('m."fechaHora"')} AS clave, m."fechaHora" AS fecha, m.monto AS importe,
      CASE WHEN m."correccionId" IS NOT NULL THEN 'CORRECCION' WHEN m.tipo = 'AJUSTE' AND m.monto < 0 THEN 'DEVOLUCION' ELSE m.tipo::text END AS concepto,
      COALESCE(NULLIF(r."licensePlateOriginal", ''), CASE WHEN r."codeBarTicket" IS NOT NULL THEN 'Ticket ' || r."codeBarTicket" END) AS identificacion,
      NULL AS extra, m."efectivoRecibido" AS recibido, m.vuelto AS vuelto
    FROM movimientos m LEFT JOIN ticket_registrations r ON r.id = m."ticketRegistrationId"
    WHERE m."turnoId" = $1 AND m.metodo = 'CASH' AND m.tipo IN ('ANTICIPO', 'SALDO', 'AJUSTE')
      AND ${clave('m."fechaHora"')} IN (SELECT clave FROM momentos)
    UNION ALL
    SELECT k.id::text, ${clave('k."createdAt"')}, k."createdAt", -k.importe,
      CASE k.tipo WHEN 'PAGO' THEN 'PAGO_INQUILINO' WHEN 'DEVOLUCION' THEN 'DEVOLUCION_INQUILINO' ELSE 'ANULACION_INQUILINO' END,
      NULLIF(trim(concat(c."lastName", ' ', c."firstName")), ''), o.tipo, NULL::int, NULL::int
    FROM cuenta_movimientos k JOIN customers c ON c.id = k."customerId"
    LEFT JOIN cuenta_movimientos o ON o.id = k."anulaId"
    WHERE k.metodo = 'CASH' AND k.tipo IN ('PAGO', 'DEVOLUCION', 'ANULACION')
      AND ${clave('k."createdAt"')} IN (SELECT clave FROM momentos)
    UNION ALL
    SELECT d.id::text, ${clave(`(d."createdAt" AT TIME ZONE current_setting('TimeZone'))`)}, d."createdAt" AT TIME ZONE current_setting('TimeZone'), d.price,
      'ESTADIA_PERIODO', NULLIF(d."vehiclePlateCustomer", ''), d."ticketTimeType"::text, d."efectivoRecibido", d.vuelto
    FROM ticket_registration_for_days d
    WHERE d.paid = true AND COALESCE(d."paymentMetodo", 'CASH') NOT IN ('TRANSFER', 'MERCADOPAGO') AND d.price > 0
      AND ${clave(`(d."createdAt" AT TIME ZONE current_setting('TimeZone'))`)} IN (SELECT clave FROM momentos)`,
  [turno.id, momentos]);

  const filas: CobroEfectivo[] = [];
  for (const momento of momentos) {
    const deCaja = entradas.filter((e) => e.clave === momento);
    const encontradas = fuentes.filter((f) => f.clave === momento);
    const enCaja = deCaja.reduce((s, e) => s + Number(e.amount), 0);
    if (encontradas.length && encontradas.reduce((s, f) => s + Number(f.importe), 0) === enCaja) {
      for (const f of encontradas)
        filas.push({ id: f.id, fecha: new Date(f.fecha).toISOString(), concepto: f.concepto, importe: Number(f.importe), sinDetalle: false,
          identificacion: f.identificacion ?? null, recibido: f.recibido == null ? null : Number(f.recibido), vuelto: f.vuelto == null ? null : Number(f.vuelto) });
      continue;
    }
    for (const e of deCaja)
      filas.push({ id: e.id, fecha: new Date(e.fecha).toISOString(), identificacion: null, importe: Number(e.amount), sinDetalle: true, recibido: null, vuelto: null,
        concepto: e.categoria === 'DEVOLUCION_ANTICIPO' ? 'DEVOLUCION_ANTICIPO' : e.categoria === 'CORRECCION' ? 'CORRECCION' : e.description === 'Ajuste de efectivo' ? 'AJUSTE_CAJA' : 'COBRO' });
  }
  // La anulación dice qué deshizo y el pase, de qué período era: van en el concepto que arma la
  // pantalla, sin otra consulta.
  const extra = new Map(fuentes.map((f) => [f.id, f.extra]));
  return resultado(filas.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.id.localeCompare(b.id))
    .map((f) => ({ ...f, periodo: f.concepto === 'ESTADIA_PERIODO' ? PERIODOS[extra.get(f.id) ?? ''] ?? null : null,
      anula: f.concepto === 'ANULACION_INQUILINO' ? (extra.get(f.id) === 'DEVOLUCION' ? 'DEVOLUCION' : 'PAGO') : null })));
}

function resultado(cobros: (CobroEfectivo & { periodo?: string | null; anula?: 'PAGO' | 'DEVOLUCION' | null })[]) {
  return {
    cobros,
    // Operaciones, no vehículos: un vehículo puede tener anticipo y saldo.
    cantidad: cobros.length,
    ingresos: cobros.reduce((s, c) => s + Math.max(0, c.importe), 0),
    egresos: cobros.reduce((s, c) => s + Math.max(0, -c.importe), 0),
    total: cobros.reduce((s, c) => s + c.importe, 0),
    sinDetalle: cobros.filter((c) => c.sinDetalle).length,
  };
}
