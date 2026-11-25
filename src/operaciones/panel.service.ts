import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { operationNow } from 'src/common/operation-context';
import { fechaValida, ramasHistorial, TZ } from './historial.service';

dayjs.extend(utc);
dayjs.extend(timezone);

export const MEDIOS_PANEL = ['CASH', 'TRANSFER', 'MERCADOPAGO'] as const;
type Medio = (typeof MEDIOS_PANEL)[number];
export type CompararPanel = 'anterior' | 'anio' | 'no';

const MAX_DIAS = 366;
// El calendario del panel: las últimas 20 semanas, de lunes a domingo, hasta la semana de hoy.
const SEMANAS_CALENDARIO = 20;

type Totales = { entradas: number; salidas: number; cobradas: number; cobradoSalidas: number; minutos: number; conDuracion: number };
const vacio = (): Totales => ({ entradas: 0, salidas: 0, cobradas: 0, cobradoSalidas: 0, minutos: 0, conDuracion: 0 });
const promedio = (suma: number, n: number) => (n ? Math.round(suma / n) : null);

/**
 * El panel de la administración (docs/panel.md): lo cobrado en un rango, comparado con otro, las
 * estadías día por día, los autos adentro hoy hora por hora, el calendario de las últimas 20
 * semanas y lo que conviene mirar. Lo cobrado sale de la misma unión que el historial de
 * movimientos (ramasHistorial): estadías por hora y por día, semana o mes, con los medios vigentes.
 * Solo lee.
 */
@Injectable()
export class PanelService {
  constructor(private readonly ds: DataSource) {}

  async resumen(q: { desde?: string; hasta?: string; comparar?: string }) {
    const hoy = dayjs(operationNow()).tz(TZ).format('YYYY-MM-DD');
    const desde = q.desde ?? dayjs(hoy).startOf('month').format('YYYY-MM-DD');
    const hasta = q.hasta ?? hoy;
    if (!fechaValida(desde) || !fechaValida(hasta) || hasta < desde) throw new BadRequestException('Revisá las fechas del filtro.');
    const dias = dayjs(hasta).diff(dayjs(desde), 'day') + 1;
    if (dias > MAX_DIAS) throw new BadRequestException('Elegí un rango de hasta un año.');
    const comparar = (q.comparar ?? 'anterior') as CompararPanel;
    if (!['anterior', 'anio', 'no'].includes(comparar)) throw new BadRequestException('Comparación inválida.');

    // El período con el que se compara: los mismos días justo antes, o las mismas fechas un año antes.
    const otro = comparar === 'no' ? null
      : comparar === 'anio' ? { desde: dayjs(desde).subtract(1, 'year').format('YYYY-MM-DD'), hasta: dayjs(hasta).subtract(1, 'year').format('YYYY-MM-DD') }
        : { desde: dayjs(desde).subtract(dias, 'day').format('YYYY-MM-DD'), hasta: dayjs(desde).subtract(1, 'day').format('YYYY-MM-DD') };

    const lunesHoy = dayjs(hoy).subtract((dayjs(hoy).day() + 6) % 7, 'day');
    const inicioCalendario = lunesHoy.subtract((SEMANAS_CALENDARIO - 1) * 7, 'day').format('YYYY-MM-DD');

    // Una consulta por vez: cada una toma su conexión con el alcance de la playa, y el panel no
    // tiene por qué ocupar medio pool en cada visita.
    const cobro = await this.cobradoPorDia(desde, hasta);
    const estadias = await this.estadiasPorDia(desde, hasta);
    const cobroOtro = otro ? await this.cobradoPorDia(otro.desde, otro.hasta) : null;
    const estadiasOtro = otro ? await this.estadiasPorDia(otro.desde, otro.hasta) : null;
    const calendario = await this.cobradoPorDia(inicioCalendario, hoy);
    const hoyData = await this.hoy(hoy);
    // Un solo día: también hora por hora, para que «Hoy» o «Ayer» tengan curva.
    const porHora = dias === 1 ? await this.cobradoPorHora(desde) : null;
    const porHoraOtro = dias === 1 && otro ? await this.cobradoPorHora(otro.desde) : null;
    const avisos = await this.avisos();

    const fechas = (d: string, n: number) => Array.from({ length: n }, (_, i) => dayjs(d).add(i, 'day').format('YYYY-MM-DD'));
    const porMedio = Object.fromEntries(MEDIOS_PANEL.map((m) => [m, 0])) as Record<Medio, number>;
    const porDia = fechas(desde, dias).map((fecha) => {
      const dia = cobro.get(fecha) ?? {};
      const fila = { fecha, total: 0, CASH: 0, TRANSFER: 0, MERCADOPAGO: 0 };
      for (const m of MEDIOS_PANEL) { fila[m] = dia[m] ?? 0; fila.total += fila[m]; porMedio[m] += fila[m]; }
      return fila;
    });
    const sumaDia = (mapa: Map<string, Partial<Record<Medio, number>>>, fecha: string) => MEDIOS_PANEL.reduce((a, m) => a + (mapa.get(fecha)?.[m] ?? 0), 0);
    const total = porDia.reduce((a, d) => a + d.total, 0);
    const diasOtro = otro ? dayjs(otro.hasta).diff(dayjs(otro.desde), 'day') + 1 : 0;
    const anterior = otro && cobroOtro ? fechas(otro.desde, diasOtro).map((fecha) => ({ fecha, total: sumaDia(cobroOtro, fecha) })) : null;

    const sumar = (mapa: Map<string, Totales>) => [...mapa.values()].reduce((a, t) => {
      (Object.keys(a) as (keyof Totales)[]).forEach((k) => { a[k] += t[k]; });
      return a;
    }, vacio());
    const resumenEstadias = (t: Totales) => ({ entradas: t.entradas, salidas: t.salidas, ticketPromedio: promedio(t.cobradoSalidas, t.cobradas), duracionPromedio: promedio(t.minutos, t.conDuracion) });

    return {
      rango: { desde, hasta, dias },
      comparacion: otro ? { modo: comparar, ...otro } : null,
      cobrado: { total, porMedio, porDia, porHora, anterior: anterior ? { total: anterior.reduce((a, d) => a + d.total, 0), porDia: anterior, porHora: porHoraOtro } : null },
      estadias: {
        ...resumenEstadias(sumar(estadias)),
        porDia: fechas(desde, dias).map((fecha) => ({ fecha, ...resumenEstadias(estadias.get(fecha) ?? vacio()) })),
        anterior: estadiasOtro ? resumenEstadias(sumar(estadiasOtro)) : null,
      },
      hoy: hoyData,
      calendario: fechas(inicioCalendario, dayjs(hoy).diff(dayjs(inicioCalendario), 'day') + 1).map((fecha) => ({ fecha, total: sumaDia(calendario, fecha) })),
      avisos,
    };
  }

  // La unión del historial en un rango de días de negocio: $1 y $2 son el inicio y el fin.
  private union(desde: string, hasta: string) {
    const inicio = dayjs.tz(`${desde} 00:00:00`, TZ).toDate();
    const fin = dayjs.tz(`${hasta} 00:00:00`, TZ).add(1, 'day').toDate();
    const rango = (expr: string) => `(${expr}) >= $1 AND (${expr}) < $2`;
    return { sql: `WITH ev AS (${ramasHistorial(rango).join('\nUNION ALL\n')})`, params: [inicio, fin] };
  }

  private async cobradoPorDia(desde: string, hasta: string) {
    const u = this.union(desde, hasta);
    const filas: { dia: string; medio: string; total: string }[] = await this.ds.query(`${u.sql}
      SELECT to_char(timezone('${TZ}', ev.fecha), 'YYYY-MM-DD') AS dia, m.key AS medio, SUM(m.value::numeric)::bigint AS total
      FROM ev, jsonb_each_text(ev.medios) m GROUP BY 1, 2`, u.params);
    const mapa = new Map<string, Partial<Record<Medio, number>>>();
    for (const f of filas) {
      if (!(MEDIOS_PANEL as readonly string[]).includes(f.medio)) continue;
      const dia = mapa.get(f.dia) ?? {};
      dia[f.medio as Medio] = Number(f.total);
      mapa.set(f.dia, dia);
    }
    return mapa;
  }

  // Lo cobrado en un día, de hora en hora (24 valores).
  private async cobradoPorHora(dia: string) {
    const u = this.union(dia, dia);
    const filas: { hora: number; total: string }[] = await this.ds.query(`${u.sql}
      SELECT EXTRACT(HOUR FROM timezone('${TZ}', ev.fecha))::int AS hora, SUM(m.value::numeric)::bigint AS total
      FROM ev, jsonb_each_text(ev.medios) m WHERE m.key = ANY($3) GROUP BY 1`, [...u.params, [...MEDIOS_PANEL]]);
    const horas = Array.from({ length: 24 }, () => 0);
    for (const f of filas) horas[Number(f.hora)] = Number(f.total);
    return horas;
  }

  // Entradas (estadías por hora y altas de pases), salidas (y retiros), lo cobrado al salir y la
  // duración de las estadías por hora, por día.
  private async estadiasPorDia(desde: string, hasta: string) {
    const u = this.union(desde, hasta);
    const filas: Record<string, string>[] = await this.ds.query(`${u.sql}
      SELECT to_char(timezone('${TZ}', fecha), 'YYYY-MM-DD') AS dia,
        COUNT(*) FILTER (WHERE tipo = 'ENTRADA' OR (tipo = 'PASE' AND detalle = 'Alta'))::int AS entradas,
        COUNT(*) FILTER (WHERE tipo = 'SALIDA' OR (tipo = 'PASE' AND detalle = 'Retiro'))::int AS salidas,
        COUNT(*) FILTER (WHERE tipo = 'SALIDA' AND importe > 0)::int AS cobradas,
        COALESCE(SUM(importe) FILTER (WHERE tipo = 'SALIDA' AND importe > 0), 0)::bigint AS "cobradoSalidas",
        COALESCE(SUM(duracion) FILTER (WHERE tipo = 'SALIDA' AND duracion >= 0), 0)::bigint AS minutos,
        COUNT(duracion) FILTER (WHERE tipo = 'SALIDA' AND duracion >= 0)::int AS "conDuracion"
      FROM ev WHERE tipo IN ('ENTRADA', 'SALIDA', 'PASE') GROUP BY 1`, u.params);
    return new Map(filas.map((f) => [f.dia, {
      entradas: Number(f.entradas), salidas: Number(f.salidas), cobradas: Number(f.cobradas),
      cobradoSalidas: Number(f.cobradoSalidas), minutos: Number(f.minutos), conDuracion: Number(f.conDuracion),
    } satisfies Totales]));
  }

  // Los autos adentro hoy al final de cada hora (la hora en curso, ahora), con el mismo criterio que
  // la caja (occupancyAt): estadías por hora sin salir y pases sin retirar. No depende de la capacidad.
  private async hoy(hoy: string) {
    const ahora = operationNow();
    const inicio = dayjs.tz(`${hoy} 00:00:00`, TZ);
    const horaActual = Math.min(23, Math.max(0, Math.floor(dayjs(ahora).diff(inicio, 'minute') / 60)));
    const filas: { h: number; adentro: number }[] = await this.ds.query(`
      SELECT h::int, (
        (SELECT COUNT(*) FROM ticket_registrations WHERE
          (("entryDay"::date + COALESCE("entryTime"::time, '00:00'::time)) AT TIME ZONE $3) < x.t
          AND ("departureTime" IS NULL OR (("departureDay"::date + "departureTime"::time) AT TIME ZONE $3) >= x.t)) +
        (SELECT COUNT(*) FROM ticket_registration_for_days WHERE "createdAt" < x.t
          AND ("retiredAt" >= x.t OR ("retiredAt" IS NULL AND COALESCE(retired, false) = false)))
      )::int AS adentro
      FROM generate_series(0, $2::int) h, LATERAL (SELECT LEAST($1::timestamptz + make_interval(hours => h + 1), $4::timestamptz) AS t) x
      ORDER BY h`, [inicio.toDate(), horaActual, TZ, ahora]);
    const porHora = filas.map((f) => Number(f.adentro));
    const estadias = await this.estadiasPorDia(hoy, hoy);
    const t = estadias.get(hoy) ?? vacio();
    return { fecha: hoy, horaActual, adentroPorHora: porHora, adentroAhora: porHora[porHora.length - 1] ?? 0, entradas: t.entradas, salidas: t.salidas };
  }

  // Lo que conviene mirar: correcciones esperando revisión y faltantes de caja de la última semana.
  // Los inquilinos con deuda vencida ya tienen su consulta (cuentas/deudores).
  private async avisos() {
    const [{ n }] = await this.ds.query(`SELECT COUNT(*)::int AS n FROM correcciones WHERE estado = 'PENDIENTE'`);
    const faltantes: { fecha: Date; diferencia: number; caja: string; usuario: string | null }[] = await this.ds.query(`
      SELECT s."fechaCierre" AS fecha, s.diferencia, c.nombre AS caja,
        COALESCE(NULLIF(trim(concat(u."firstName", ' ', u."lastName")), ''), u.username) AS usuario
      FROM cash_sessions s JOIN cash_registers c ON c.id = s."cajaId" LEFT JOIN users u ON u.id = s."usuarioCierreId"
      WHERE s.estado = 'CERRADO' AND NOT s."cierreAutomatico" AND s.diferencia < 0 AND s."fechaCierre" >= $1
      ORDER BY s."fechaCierre" DESC`, [dayjs(operationNow()).subtract(7, 'day').toDate()]);
    const ultimo = faltantes[0];
    return {
      correccionesPendientes: Number(n),
      faltantes: {
        cantidad: faltantes.length,
        total: faltantes.reduce((a, f) => a - Number(f.diferencia), 0),
        ultimo: ultimo ? { fecha: new Date(ultimo.fecha).toISOString(), diferencia: Number(ultimo.diferencia), caja: ultimo.caja, usuario: ultimo.usuario } : null,
      },
    };
  }
}
