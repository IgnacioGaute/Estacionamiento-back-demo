import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { operationNow } from 'src/common/operation-context';
import { ListPagination, listResult } from 'src/utils/list-pagination';
import { TIPOS_HISTORIAL, TipoHistorial } from './dto/correccion.dto';
import { esAdministracion, Actor } from './correcciones.service';

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = 'America/Argentina/Buenos_Aires';

export type FiltrosHistorial = {
  desde?: string; hasta?: string; turnoId?: string; operadorId?: string; q?: string;
  medio?: string; tipo?: string; correccion?: string;
};

const fechaValida = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && dayjs(s).isValid() && dayjs(s).format('YYYY-MM-DD') === s;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * El historial de movimientos de la playa: lo que pasó, persistido en el servidor, con filtros y
 * paginación en la consulta (no el tablero ampliado). Un renglón por evento:
 *
 * - ENTRADA y SALIDA de las estadías por hora. La SALIDA lleva lo cobrado al salir (los SALDO de
 *   la estadía y los ajustes de sus correcciones de medio o de vehículo), así que una salida y su
 *   cobro son un solo renglón, nunca dos ingresos.
 * - ANTICIPO (cada uno), COBRO_PARCIAL (lo cobrado de una estadía que todavía no salió) y
 *   DEVOLUCION (ajustes que no son de una corrección: devolver o reducir un anticipo).
 * - PASE: alta (con su cobro si se cobró al registrarla) y retiro de las estadías por día, semana o mes.
 * - CORRECCION: cada corrección, con su estado; no lleva importe (el efecto ya está en la operación).
 *
 * Los medios son los vigentes (con las correcciones aplicadas); el original se ve en el detalle.
 * Un operador ve solo sus operaciones, como en la planilla.
 */
@Injectable()
export class HistorialService {
  constructor(private readonly ds: DataSource) {}

  async listar(f: FiltrosHistorial, pagination: ListPagination, actor: Actor) {
    const hoy = dayjs(operationNow()).tz(TZ).format('YYYY-MM-DD');
    const desde = f.desde ?? hoy;
    const hasta = f.hasta ?? desde;
    if (!fechaValida(desde) || !fechaValida(hasta) || hasta < desde) throw new BadRequestException('Revisá las fechas del filtro.');
    if (dayjs(hasta).diff(dayjs(desde), 'day') > 92) throw new BadRequestException('Elegí un rango de hasta tres meses.');
    if (f.tipo && !(TIPOS_HISTORIAL as readonly string[]).includes(f.tipo)) throw new BadRequestException('Tipo de movimiento inválido.');
    if (f.medio && !['CASH', 'TRANSFER', 'MERCADOPAGO'].includes(f.medio)) throw new BadRequestException('Medio inválido.');
    if (f.correccion && !['CORREGIDA', 'PENDIENTE', 'RECHAZADA', 'SIN'].includes(f.correccion)) throw new BadRequestException('Estado de corrección inválido.');
    for (const id of [f.turnoId, f.operadorId]) if (id && !UUID.test(id)) throw new BadRequestException('Identificador inválido.');

    const inicio = dayjs.tz(`${desde} 00:00:00`, TZ).toDate();
    const fin = dayjs.tz(`${hasta} 00:00:00`, TZ).add(1, 'day').toDate();
    const params: unknown[] = [inicio, fin];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const rango = (expr: string) => `(${expr}) >= $1 AND (${expr}) < $2`;

    const ident = `COALESCE(NULLIF(r."licensePlateOriginal", ''), CASE WHEN r."codeBarTicket" IS NOT NULL THEN 'Ticket ' || r."codeBarTicket" END, NULLIF(r."lastNameCustomer", ''), 'Sin patente')`;
    const busca = `CONCAT_WS(' ', r."licensePlateOriginal", r."codeBarTicket", r."lastNameCustomer")`;
    const entrada = `((r."entryDay"::date + COALESCE(r."entryTime"::time, '00:00'::time)) AT TIME ZONE '${TZ}')`;
    const salida = `((r."departureDay"::date + r."departureTime"::time) AT TIME ZONE '${TZ}')`;
    const nombreUsuario = `NULLIF(trim(concat(u."firstName", ' ', u."lastName")), '')`;
    // El estado de corrección de una operación: pendiente manda sobre aplicada.
    const estadoDe = (cond: string) => `(SELECT CASE WHEN bool_or(c.estado = 'PENDIENTE') THEN 'PENDIENTE' WHEN bool_or(c.estado = 'APLICADA') THEN 'CORREGIDA'
      WHEN bool_or(c.estado = 'RECHAZADA') THEN 'RECHAZADA' END FROM correcciones c WHERE ${cond})`;
    const recibidoVigente = (mov: string, campo: 'efectivoRecibido' | 'vuelto') => `COALESCE(
      (SELECT (c.despues->>'${campo}')::int FROM correcciones c WHERE c."movimientoId" = ${mov}.id AND c.tipo = 'RECIBIDO_VUELTO' AND c.estado = 'APLICADA' ORDER BY c."aplicadaEl" DESC LIMIT 1),
      ${mov}."${campo}")`;

    const ramas = [
      // Entradas: evento operativo, sin plata.
      `SELECT 'E:' || r.id AS id, 'ENTRADA' AS tipo, ${entrada} AS fecha, r.id AS "registrationId", NULL::uuid AS "paseId", ${ident} AS identificacion,
         ${busca} AS busca, r."entryOperatorName" AS operador, NULL::uuid AS "usuarioId", NULL::uuid AS "turnoId", NULL::int AS importe, NULL::jsonb AS medios,
         NULL::int AS recibido, NULL::int AS vuelto, ${estadoDe(`c."registrationId" = r.id OR c."destinoRegistrationId" = r.id`)} AS correccion, NULL::text AS detalle
       FROM ticket_registrations r WHERE ${rango(entrada)}`,
      // Salidas, con lo cobrado al salir (vigente).
      `SELECT 'S:' || r.id, 'SALIDA', ${salida}, r.id, NULL::uuid, ${ident}, ${busca}, r."exitOperatorName", NULL::uuid, r."exitTurnoId", pago.importe, pago.medios,
         rv.recibido, rv.vuelto, ${estadoDe(`c."registrationId" = r.id OR c."destinoRegistrationId" = r.id`)}, NULL::text
       FROM ticket_registrations r
       LEFT JOIN LATERAL (SELECT SUM(total)::int AS importe, jsonb_object_agg(metodo, total) FILTER (WHERE total <> 0) AS medios FROM (
           SELECT m.metodo::text AS metodo, SUM(m.monto)::int AS total FROM movimientos m
             LEFT JOIN correcciones cc ON cc.id = m."correccionId" LEFT JOIN movimientos o ON o.id = cc."movimientoId"
            WHERE m."ticketRegistrationId" = r.id AND (m.tipo = 'SALDO' OR (m.tipo = 'AJUSTE' AND (cc.tipo = 'VEHICULO' OR o.tipo = 'SALDO')))
            GROUP BY m.metodo) x) pago ON true
       LEFT JOIN LATERAL (SELECT ${recibidoVigente('m', 'efectivoRecibido')} AS recibido, ${recibidoVigente('m', 'vuelto')} AS vuelto FROM movimientos m
           WHERE m."ticketRegistrationId" = r.id AND m.tipo = 'SALDO' AND m.metodo = 'CASH' AND m.monto > 0 ORDER BY m.sequence DESC LIMIT 1) rv ON true
       WHERE r."departureTime" IS NOT NULL AND ${rango(salida)}`,
      // Anticipos, cobros parciales (estadía todavía adentro) y devoluciones: cada movimiento de plata
      // que no forma parte de una salida. Los medios, con sus correcciones de medio aplicadas.
      `SELECT 'M:' || m.id, CASE WHEN m.tipo = 'ANTICIPO' THEN 'ANTICIPO' WHEN m.tipo = 'SALDO' THEN 'COBRO_PARCIAL' ELSE 'DEVOLUCION' END, m."fechaHora",
         r.id, NULL::uuid, ${ident}, ${busca}, COALESCE(${nombreUsuario}, u.username), m."usuarioId", m."turnoId",
         (m.monto + COALESCE(aj.neto, 0))::int, aj.medios,
         CASE WHEN m.metodo = 'CASH' AND m.monto > 0 THEN ${recibidoVigente('m', 'efectivoRecibido')} END, CASE WHEN m.metodo = 'CASH' AND m.monto > 0 THEN ${recibidoVigente('m', 'vuelto')} END,
         ${estadoDe(`c."movimientoId" = m.id`)}, m.motivo
       FROM movimientos m JOIN ticket_registrations r ON r.id = m."ticketRegistrationId" LEFT JOIN users u ON u.id = m."usuarioId"
       LEFT JOIN LATERAL (SELECT SUM(x.total) - m.monto AS neto, jsonb_object_agg(x.metodo, x.total) FILTER (WHERE x.total <> 0) AS medios FROM (
           SELECT metodo, SUM(monto)::int AS total FROM (
             SELECT m.metodo::text AS metodo, m.monto
             UNION ALL SELECT a.metodo::text, a.monto FROM movimientos a JOIN correcciones c ON c.id = a."correccionId" WHERE c."movimientoId" = m.id AND c.tipo = 'MEDIO_PAGO') y
           GROUP BY metodo) x) aj ON true
       WHERE m."correccionId" IS NULL AND m.tipo IN ('ANTICIPO', 'SALDO', 'AJUSTE')
         AND NOT (m.tipo = 'SALDO' AND r."departureTime" IS NOT NULL)
         -- El cobro de una salida registrada sobre el vehículo equivocado pasó al que salió: no es un cobro parcial de este.
         AND NOT (m.tipo = 'SALDO' AND EXISTS (SELECT 1 FROM correcciones v WHERE v.tipo = 'VEHICULO' AND v.estado = 'APLICADA' AND v."registrationId" = r.id AND COALESCE(v."aplicadaEl", v."createdAt") > m."fechaHora"))
         AND ${rango('m."fechaHora"')}`,
      // Estadías por día, semana o mes: el alta (con su cobro si se cobró al registrarla) y el retiro.
      `SELECT 'P:' || d.id, 'PASE', d."createdAt" AT TIME ZONE current_setting('TimeZone'), NULL::uuid, d.id,
         COALESCE(NULLIF(d."vehiclePlateCustomer", ''), d."lastNameCustomer", 'Sin patente'), CONCAT_WS(' ', d."vehiclePlateCustomer", d."lastNameCustomer"),
         COALESCE(d."paymentOperatorName", d."entryOperatorName"), NULL::uuid, NULL::uuid,
         CASE WHEN d.paid THEN d.price END, CASE WHEN d.paid THEN jsonb_build_object(COALESCE(d."paymentMetodo", 'CASH'), d.price) END,
         CASE WHEN d.paid THEN COALESCE((SELECT (c.despues->>'efectivoRecibido')::int FROM correcciones c WHERE c."paseId" = d.id AND c.tipo = 'RECIBIDO_VUELTO' AND c.estado = 'APLICADA' ORDER BY c."aplicadaEl" DESC LIMIT 1), d."efectivoRecibido") END,
         CASE WHEN d.paid THEN COALESCE((SELECT (c.despues->>'vuelto')::int FROM correcciones c WHERE c."paseId" = d.id AND c.tipo = 'RECIBIDO_VUELTO' AND c.estado = 'APLICADA' ORDER BY c."aplicadaEl" DESC LIMIT 1), d.vuelto) END,
         ${estadoDe(`c."paseId" = d.id`)}, 'Alta'
       FROM ticket_registration_for_days d WHERE ${rango(`d."createdAt" AT TIME ZONE current_setting('TimeZone')`)}`,
      `SELECT 'R:' || d.id, 'PASE', d."retiredAt", NULL::uuid, d.id, COALESCE(NULLIF(d."vehiclePlateCustomer", ''), d."lastNameCustomer", 'Sin patente'),
         CONCAT_WS(' ', d."vehiclePlateCustomer", d."lastNameCustomer"), d."exitOperatorName", NULL::uuid, d."exitTurnoId", NULL::int, NULL::jsonb, NULL::int, NULL::int,
         ${estadoDe(`c."paseId" = d.id`)}, 'Retiro'
       FROM ticket_registration_for_days d WHERE d.retired = true AND d."retiredAt" IS NOT NULL AND ${rango('d."retiredAt"')}`,
      // Las correcciones, con su propio estado.
      `SELECT 'C:' || c.id, 'CORRECCION', c."createdAt", c."registrationId", c."paseId",
         CASE WHEN r.id IS NOT NULL THEN ${ident} ELSE COALESCE(NULLIF(d."vehiclePlateCustomer", ''), d."lastNameCustomer", 'Sin patente') END,
         CONCAT_WS(' ', r."licensePlateOriginal", r."codeBarTicket", r."lastNameCustomer", d."vehiclePlateCustomer", d."lastNameCustomer"),
         c."usuarioNombre", c."usuarioId", c."turnoId", NULL::int, NULL::jsonb, NULL::int, NULL::int,
         CASE c.estado WHEN 'APLICADA' THEN 'CORREGIDA' ELSE c.estado END, c.tipo
       FROM correcciones c LEFT JOIN ticket_registrations r ON r.id = c."registrationId" LEFT JOIN ticket_registration_for_days d ON d.id = c."paseId"
       WHERE ${rango('c."createdAt"')}`,
    ];

    const condiciones: string[] = [];
    // El operador ve sus operaciones: las que registró (por usuario o por el nombre que guardan
    // entradas y salidas), como en la planilla. Administración, todas.
    const limitarA = async (usuarioId: string) => {
      const [u] = await this.ds.query(`SELECT "firstName", "lastName", username FROM users WHERE id = $1`, [usuarioId]);
      const nombre = u ? (`${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.username) : '';
      condiciones.push(`("usuarioId" = ${p(usuarioId)} OR ("usuarioId" IS NULL AND operador = ${p(nombre)}))`);
    };
    if (!esAdministracion(actor.rol)) await limitarA(actor.usuarioId);
    if (f.operadorId) await limitarA(f.operadorId);
    if (f.turnoId) {
      // El turno: lo que se registró en él y las entradas que su operador cargó mientras estuvo
      // abierto. Es la jornada entera: si se cortó a las 00:00, sus tramos también.
      const [t] = await this.ds.query(`SELECT array_agg(j.id) AS ids, MIN(j."fechaApertura") AS apertura,
          CASE WHEN bool_or(j."fechaCierre" IS NULL) THEN NULL ELSE MAX(j."fechaCierre") END AS cierre,
          MIN(COALESCE(NULLIF(trim(concat(u."firstName", ' ', u."lastName")), ''), u.username)) AS nombre
        FROM turnos t JOIN turnos j ON j.id = COALESCE(t."jornadaId", t.id) OR j."jornadaId" = COALESCE(t."jornadaId", t.id)
        LEFT JOIN users u ON u.id = t."usuarioAperturaId"
        WHERE t.id = $1`, [f.turnoId]);
      if (!t?.ids) return { ...listResult([], 0, pagination), filtros: { desde, hasta } };
      condiciones.push(`("turnoId" = ANY(${p(t.ids)}::uuid[]) OR (tipo = 'ENTRADA' AND operador = ${p(t.nombre)} AND fecha >= ${p(t.apertura)} AND fecha < ${p(t.cierre ?? new Date('9999-01-01'))}))`);
    }
    if (f.q?.trim()) condiciones.push(`regexp_replace(upper(busca), '[^A-Z0-9]', '', 'g') LIKE ${p('%' + f.q.slice(0, 60).toUpperCase().replace(/[^A-Z0-9]/g, '') + '%')}`);
    if (f.medio) condiciones.push(`medios ? ${p(f.medio)}`);
    if (f.tipo) condiciones.push(`tipo = ${p(f.tipo as TipoHistorial)}`);
    if (f.correccion) condiciones.push(f.correccion === 'SIN' ? 'correccion IS NULL' : `correccion = ${p(f.correccion)}`);

    const consulta = `WITH ev AS (${ramas.join('\nUNION ALL\n')}) SELECT * FROM ev ${condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : ''}`;
    const [{ total }] = await this.ds.query(`SELECT COUNT(*)::int AS total FROM (${consulta}) x`, params);
    const filas = await this.ds.query(`${consulta} ORDER BY fecha DESC, id DESC LIMIT ${p(pagination.limit)} OFFSET ${p((pagination.page - 1) * pagination.limit)}`, params);
    return {
      ...listResult(filas.map((f: Record<string, any>) => ({
        id: f.id, tipo: f.tipo, fecha: new Date(f.fecha).toISOString(), registrationId: f.registrationId, paseId: f.paseId,
        identificacion: f.identificacion, operador: f.operador, turnoId: f.turnoId, importe: f.importe == null ? null : Number(f.importe),
        medios: f.medios ?? null, recibido: f.recibido == null ? null : Number(f.recibido), vuelto: f.vuelto == null ? null : Number(f.vuelto),
        correccion: f.correccion ?? null, detalle: f.detalle ?? null,
      })), Number(total), pagination),
      filtros: { desde, hasta },
    };
  }
}
