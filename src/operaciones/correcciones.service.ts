import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, IsNull, Not } from 'typeorm';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { operationNow, operationTransaction } from 'src/common/operation-context';
import { publishAutomaticNote } from 'src/notes/automatic-note';
import { MovimientosService } from 'src/movimientos/movimientos.service';
import { Movimiento } from 'src/movimientos/entities/movimiento.entity';
import { efectivoDeclarado } from 'src/movimientos/efectivo-recibido';
import { BoxListsService } from 'src/box-lists/box-lists.service';
import { TicketsService } from 'src/tickets/tickets.service';
import { TicketRegistration } from 'src/tickets/entities/ticket-registration.entity';
import { TicketRegistrationForDay } from 'src/tickets/entities/ticket-registration-for-day.entity';
import { TicketScheduleSettings } from 'src/tickets/entities/ticket-schedule-settings.entity';
import { normalizePlate, toSearchKey } from 'src/tickets/utils/license-plate.util';
import { Turno } from 'src/turnos/entities/turno.entity';
import { CashSession } from 'src/turnos/entities/cash-session.entity';
import { rolloverShifts } from 'src/turnos/turno-book';
import { esGratuita } from 'src/tenancy/modalidad';
import { Correccion, EstadoCorreccion, TipoCorreccion } from './entities/correccion.entity';
import { CorreccionDto, ResolverCorreccionDto } from './dto/correccion.dto';

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = 'America/Argentina/Buenos_Aires';

// Lo que necesita la verificación de transferencias (VerificacionAliasService). Una interfaz y no
// la clase para que las pruebas usen un doble sin Mercado Pago.
export interface VerificacionParaCorreccion {
  candidatasParaCorreccion(importe: number, cobradoEl: Date): Promise<{ disponible: boolean; motivo: string | null; opciones: unknown[] }>;
  usarEnCorreccion(m: EntityManager, operacionId: string, datos: { importe: number; cobradoEl: Date; registrationId: string; usuarioId: string }): Promise<{ transferenciaId: string; operacionId: string; paymentTypeId: string | null }>;
}

export type Actor = { usuarioId: string; rol?: string | null };
// `sinContar`: la caja de la operación se cerró sola a las 00:00, sin arqueo; se cuenta al abrirla.
type Permiso = { directo: boolean; revision: string | null; turnoId: string | null; imputadaTurnoId: string | null; posteriorAlCierre: boolean; sinContar?: boolean };
type Datos = Pick<CorreccionDto, 'tipo' | 'registrationId' | 'paseId' | 'motivo' | 'detalle' | 'patente' | 'movimientoId' | 'metodo' | 'importe' | 'operacionId' | 'efectivoRecibido' | 'destinoRegistrationId'>;
type Plan = {
  registrationId: string | null; paseId: string | null; movimientoId: string | null; destinoRegistrationId: string | null;
  identificacion: string; permiso: Permiso;
  antes: Record<string, unknown>; despues: Record<string, unknown>; lineas: string[]; efectivo: number; digital: number;
  // Necesita la revisión de administración (solo para quien no es administración).
  revision: string | null;
  // No se puede aplicar sola de forma segura: queda para revisión con el contexto, y administración
  // la resuelve a mano (no la aplica este circuito).
  bloqueo: string | null;
  aplicar?: (c: Correccion, m: EntityManager) => Promise<void>;
  afectadas: string[];
};

const pesos = (n: number) => '$' + Math.round(Number(n)).toLocaleString('es-AR');
const MEDIO: Record<string, string> = { CASH: 'efectivo', TRANSFER: 'transferencia', MERCADOPAGO: 'Mercado Pago (QR)' };
export const esAdministracion = (rol?: string | null) => rol === 'ADMIN' || rol === 'SUPER_ADMIN';
const hoy = () => dayjs(operationNow()).tz(TZ).format('YYYY-MM-DD');
const identificacionDe = (r: TicketRegistration) =>
  r.licensePlateOriginal || (r.codeBarTicket ? `Ticket ${r.codeBarTicket}` : null) || r.lastNameCustomer || 'Sin patente';
const salidaDe = (r: TicketRegistration) =>
  r.departureDay && r.departureTime ? dayjs.tz(`${r.departureDay} ${r.departureTime}`, 'YYYY-MM-DD HH:mm:ss', TZ).toDate() : null;
// Un cobro que Mercado Pago confirmó (QR, o transferencia al alias detectada): es plata real en la
// cuenta, y una corrección interna no la reclasifica, cancela ni devuelve.
const confirmadoPorMp = (m: Movimiento) => m.metodo === 'MERCADOPAGO' || (m.metodo === 'TRANSFER' && /^Transferencia MercadoPago /.test(m.referencia ?? ''));

/**
 * Correcciones de registros ya hechos: patente, medio de pago, lo declarado recibido y el vuelto, y
 * la salida registrada sobre el vehículo equivocado. Ver docs/correcciones.md.
 *
 * Quién la aplica:
 * - El operador, directamente, sobre sus propias operaciones del turno (la jornada) que tiene
 *   abierto, cuando se cumplen las validaciones de cada tipo.
 * - Administración, sobre cualquier operación de la playa: es quien revisa.
 * - Todo lo demás (operaciones de otro operador, de un turno cerrado, sin evidencia) queda
 *   PENDIENTE: no cambia nada hasta que administración la aplique o la rechace.
 *
 * El original nunca se borra ni se sobrescribe: los cambios de plata son movimientos de ajuste
 * vinculados a la corrección (`movimientos.correccionId`), todo en una transacción, con el bloqueo
 * de caja de siempre. El efecto va al turno abierto de la caja de esa operación; si esa caja ya se
 * contó y cerró, el arqueo original no cambia y la corrección queda vinculada a ese cierre.
 */
@Injectable()
export class CorreccionesService {
  constructor(
    private readonly ds: DataSource,
    private readonly movimientos: MovimientosService,
    private readonly cajas: BoxListsService,
    private readonly tickets: TicketsService,
    private readonly verificacion: VerificacionParaCorreccion,
  ) {}

  // ------------------------------------------------------------------ consultas

  /** El estado de una estadía que firma el formulario: si cambia, la corrección se vuelve a mirar. */
  async versionEstadia(m: EntityManager, id: string) {
    const [f] = await m.query(`SELECT r."departureDay"::text AS dia, r."departureTime"::text AS hora, r."licensePlateNormalized" AS patente,
        (SELECT COALESCE(MAX(sequence), 0) FROM movimientos WHERE "ticketRegistrationId" = r.id) AS seq,
        (SELECT COUNT(*) FROM correcciones WHERE "registrationId" = r.id OR "destinoRegistrationId" = r.id) AS corr
      FROM ticket_registrations r WHERE r.id = $1`, [id]);
    if (!f) throw new NotFoundException('Registro no encontrado.');
    return [f.dia, f.hora, f.patente, f.seq, f.corr].map((v) => v ?? '').join('|');
  }

  async versionPase(m: EntityManager, id: string) {
    const [f] = await m.query(`SELECT p.price, p.paid, p.retired, p."paymentMetodo" AS metodo, p."efectivoRecibido" AS recibido,
        (SELECT COUNT(*) FROM correcciones WHERE "paseId" = p.id) AS corr
      FROM ticket_registration_for_days p WHERE p.id = $1`, [id]);
    if (!f) throw new NotFoundException('Estadía no encontrada.');
    return [f.price, f.paid, f.retired, f.metodo, f.recibido, f.corr].map((v) => v ?? '').join('|');
  }

  private async nombre(m: EntityManager, usuarioId: string) {
    const [u] = await m.query(`SELECT "firstName", "lastName", username FROM users WHERE id = $1`, [usuarioId]);
    return u ? (`${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.username) : null;
  }

  // Lo que el operador declaró recibir y el vuelto vigentes de un cobro: la última corrección
  // aplicada o, si no hay, lo que se guardó al cobrar (null si no se guardó).
  private async recibidoVigente(m: EntityManager, mov: { id: string; efectivoRecibido: number | null; vuelto: number | null }) {
    const [c] = await m.query(`SELECT despues FROM correcciones WHERE "movimientoId" = $1 AND tipo = 'RECIBIDO_VUELTO' AND estado = 'APLICADA'
      ORDER BY "aplicadaEl" DESC LIMIT 1`, [mov.id]);
    if (c) return { efectivoRecibido: Number(c.despues.efectivoRecibido), vuelto: Number(c.despues.vuelto), corregido: true };
    return { efectivoRecibido: mov.efectivoRecibido, vuelto: mov.vuelto, corregido: false };
  }

  // Un cobro de la salida que pasó a otra estadía con «vehículo equivocado»: ya no es de esta
  // estadía (lo compensa un ajuste) y se corrige, si hace falta, en la que de verdad salió.
  private async movidoPorVehiculo(m: EntityManager, mov: Pick<Movimiento, 'id' | 'tipo' | 'correccionId' | 'fechaHora'>, registrationId: string) {
    if (mov.tipo !== 'SALDO' || mov.correccionId) return false;
    const [f] = await m.query(`SELECT EXISTS(SELECT 1 FROM correcciones v WHERE v.tipo = 'VEHICULO' AND v.estado = 'APLICADA'
      AND v."registrationId" = $1 AND COALESCE(v."aplicadaEl", v."createdAt") > $2) AS movido`, [registrationId, mov.fechaHora]);
    return !!f?.movido;
  }

  private async corregidoDelCobro(m: EntityManager, movimientoId: string) {
    const [f] = await m.query(`SELECT COALESCE(SUM((despues->>'importe')::int), 0) AS total FROM correcciones
      WHERE "movimientoId" = $1 AND tipo = 'MEDIO_PAGO' AND estado = 'APLICADA'`, [movimientoId]);
    return Number(f.total);
  }

  /**
   * Quién puede aplicar la corrección de una operación y a qué turno va el efecto en la caja.
   * `op`: el turno y el usuario de la operación original y cuándo fue.
   */
  async permiso(m: EntityManager, op: { turnoId: string | null; usuarioId: string | null; fecha: Date | null }, actor: Actor): Promise<Permiso> {
    const admin = esAdministracion(actor.rol);
    const turno = op.turnoId ? await m.getRepository(Turno).findOne({ where: { id: op.turnoId } }) : null;
    const sesion = turno?.cashSessionId ? await m.getRepository(CashSession).findOne({ where: { id: turno.cashSessionId } }) : null;
    const cajaAbierta = sesion ? sesion.estado === 'ABIERTO' : !!turno && turno.estado === 'ABIERTO';
    // La jornada sigue aunque el tramo original se haya cortado a las 00:00: su tramo abierto.
    const raiz = turno ? (turno.jornadaId ?? turno.id) : null;
    const tramo = raiz ? await m.getRepository(Turno).createQueryBuilder('t')
      .where("t.estado = 'ABIERTO' AND (t.id = :raiz OR t.jornadaId = :raiz)", { raiz }).getOne() : null;
    // El efecto en el efectivo va al turno abierto de esa caja: el de la jornada de la operación o,
    // si ese operador ya se fue de una caja compartida que sigue abierta, otro de la misma caja.
    let imputada: string | null = null;
    if (cajaAbierta) imputada = tramo?.id ?? (sesion
      ? (await m.getRepository(Turno).findOne({ where: { cashSessionId: sesion.id, estado: 'ABIERTO' }, order: { fechaApertura: 'DESC' } }))?.id ?? null
      : null);
    const base = { turnoId: turno?.id ?? null, imputadaTurnoId: imputada, posteriorAlCierre: !!turno && !cajaAbierta,
      sinContar: !!turno && !cajaAbierta && (sesion ? sesion.cierreAutomatico && sesion.efectivoContado == null : turno.cierreAutomatico && turno.efectivoContado == null) };
    if (admin) return { ...base, directo: true, revision: null };
    const revision = (motivo: string): Permiso => ({ ...base, directo: false, revision: motivo });
    if (turno) {
      if (turno.usuarioAperturaId !== actor.usuarioId) return revision('La operación la registró otro operador: la revisa administración.');
      if (!tramo || tramo.usuarioAperturaId !== actor.usuarioId) return revision('El turno de esa operación ya cerró: la revisa administración.');
      return { ...base, imputadaTurnoId: tramo.id, posteriorAlCierre: false, directo: true, revision: null };
    }
    // Sin turno: solo si los turnos están apagados, es propia y es de hoy.
    const settings = await m.getRepository(TicketScheduleSettings).findOne({ where: {} });
    if (settings?.shiftsEnabled) return revision('La operación no tiene turno: la revisa administración.');
    if (op.usuarioId !== actor.usuarioId) return revision('La operación la registró otro operador: la revisa administración.');
    if (!op.fecha || dayjs(op.fecha).tz(TZ).format('YYYY-MM-DD') !== hoy()) return revision('La operación es de otro día: la revisa administración.');
    return { ...base, directo: true, revision: null };
  }

  // El turno y el usuario de una salida: el turno que la registró y su dueño.
  private async opDeSalida(m: EntityManager, r: TicketRegistration) {
    const turno = r.exitTurnoId ? await m.getRepository(Turno).findOne({ where: { id: r.exitTurnoId } }) : null;
    let usuarioId = turno?.usuarioAperturaId ?? null;
    if (!usuarioId) {
      const [mov] = await m.query(`SELECT "usuarioId" FROM movimientos WHERE "ticketRegistrationId" = $1 AND tipo = 'SALDO' ORDER BY sequence DESC LIMIT 1`, [r.id]);
      usuarioId = mov?.usuarioId ?? null;
    }
    return { turnoId: r.exitTurnoId, usuarioId, fecha: salidaDe(r) };
  }

  // ------------------------------------------------------------------ planes por tipo

  private async estadiaBloqueada(m: EntityManager, id: string) {
    const r = await m.getRepository(TicketRegistration).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!r) throw new NotFoundException('Registro no encontrado.');
    const conTicket = await m.getRepository(TicketRegistration).findOne({ where: { id }, relations: ['ticket'] });
    r.ticket = conTicket?.ticket ?? null;
    return r;
  }

  private async cobroDe(m: EntityManager, registrationId: string, movimientoId?: string) {
    if (!movimientoId) throw new BadRequestException({ code: 'COBRO_REQUERIDO', message: 'Elegí qué cobro hay que corregir.' });
    // Sin bloqueo de fila: la corrección corre con el bloqueo de caja tomado (pg_advisory_xact_lock).
    const mov = await m.getRepository(Movimiento).findOne({ where: { id: movimientoId }, relations: ['ticketRegistration', 'turno', 'usuario'] });
    if (!mov || mov.ticketRegistration?.id !== registrationId) throw new NotFoundException('Ese cobro no es de esta estadía.');
    // Los cobros que pasaron a esta estadía con «vehículo equivocado» (SALDO con correccionId) se
    // corrigen como cualquier otro; los ajustes, no.
    if (!['SALDO', 'ANTICIPO'].includes(mov.tipo) || !(mov.monto > 0))
      throw new BadRequestException({ code: 'COBRO_NO_CORREGIBLE', message: 'Solo se corrigen cobros (anticipos y cobros de la salida), no los ajustes.' });
    if (await this.movidoPorVehiculo(m, mov, registrationId))
      throw new BadRequestException({ code: 'COBRO_MOVIDO', message: 'Ese cobro pasó a la estadía que de verdad salió: corregilo ahí.' });
    return mov;
  }

  private async planificar(m: EntityManager, d: Datos, actor: Actor, propia?: string): Promise<Plan> {
    const admin = esAdministracion(actor.rol);
    const vacio = { movimientoId: null, destinoRegistrationId: null, revision: null, bloqueo: null, efectivo: 0, digital: 0, afectadas: [] as string[] };

    if (d.paseId) {
      // Pases por día, semana o mes: se corrige lo declarado recibido; lo demás lo revisa administración.
      const p = await m.getRepository(TicketRegistrationForDay).findOne({ where: { id: d.paseId }, lock: { mode: 'pessimistic_write' } });
      if (!p) throw new NotFoundException('Estadía no encontrada.');
      const ident = p.vehiclePlateCustomer || p.lastNameCustomer || 'Sin patente';
      const nombre = await this.nombre(m, actor.usuarioId);
      const mismoDia = dayjs(p.createdAt).tz(TZ).format('YYYY-MM-DD') === hoy();
      const propio = admin || (!!nombre && p.paymentOperatorName === nombre && mismoDia);
      const permiso: Permiso = { directo: propio, revision: propio ? null : 'La revisa administración: es de otro operador o de otro día.', turnoId: null, imputadaTurnoId: null, posteriorAlCierre: false };
      if (d.tipo === 'RECIBIDO_VUELTO') {
        if (!p.paid || ['TRANSFER', 'MERCADOPAGO'].includes(p.paymentMetodo ?? '')) throw new BadRequestException({ code: 'SIN_EFECTIVO', message: 'Esa estadía no se cobró en efectivo.' });
        const [c] = await m.query(`SELECT despues FROM correcciones WHERE "paseId" = $1 AND tipo = 'RECIBIDO_VUELTO' AND estado = 'APLICADA' ORDER BY "aplicadaEl" DESC LIMIT 1`, [p.id]);
        const antes = c ? { efectivoRecibido: Number(c.despues.efectivoRecibido), vuelto: Number(c.despues.vuelto) } : { efectivoRecibido: p.efectivoRecibido, vuelto: p.vuelto };
        const nuevo = efectivoDeclarado(p.price, d.efectivoRecibido ?? undefined)!;
        if (antes.efectivoRecibido === nuevo.efectivoRecibido) throw new BadRequestException({ code: 'SIN_CAMBIOS', message: 'Es lo mismo que ya figura.' });
        return { ...vacio, registrationId: null, paseId: p.id, identificacion: ident, permiso, antes, despues: { ...nuevo },
          lineas: this.lineasRecibido(ident, p.price, antes, nuevo), revision: permiso.revision };
      }
      if (d.tipo !== 'OTRO') throw new BadRequestException({ code: 'CORRECCION_NO_DISPONIBLE', message: 'En una estadía por día, semana o mes se corrige lo que entregó el cliente; lo demás, con «Otro error».' });
      return this.planOtro(d, { ...vacio, registrationId: null, paseId: p.id, identificacion: ident, permiso });
    }

    if (!d.registrationId) throw new BadRequestException('Indicá la operación a corregir.');
    const r = await this.estadiaBloqueada(m, d.registrationId);
    const ident = identificacionDe(r);
    const base = { ...vacio, registrationId: r.id, paseId: null, identificacion: ident };

    switch (d.tipo) {
      case 'MEDIO_PAGO': {
        const mov = await this.cobroDe(m, r.id, d.movimientoId);
        if (!d.metodo || d.metodo === mov.metodo) throw new BadRequestException({ code: 'MEDIO_IGUAL', message: 'Elegí el medio correcto: es el mismo que figura.' });
        const permiso = await this.permiso(m, { turnoId: mov.turno?.id ?? null, usuarioId: mov.usuario?.id ?? null, fecha: mov.fechaHora }, actor);
        const pendientes = await m.getRepository(Correccion).count({ where: { movimientoId: mov.id, tipo: 'MEDIO_PAGO', estado: 'PENDIENTE', ...(propia ? { id: Not(propia) } : {}) } });
        if (pendientes) throw new ConflictException({ code: 'CORRECCION_PENDIENTE', message: 'Ese cobro ya tiene una corrección de medio esperando revisión.' });
        const restante = mov.monto - await this.corregidoDelCobro(m, mov.id);
        if (restante <= 0) throw new ConflictException({ code: 'YA_CORREGIDO', message: 'Ese cobro ya se corrigió por completo.' });
        const importe = d.importe ?? restante;
        if (importe > restante) throw new BadRequestException({ code: 'IMPORTE_MAYOR', message: `De ese cobro queda ${pesos(restante)} por corregir.` });
        const efectivo = (d.metodo === 'CASH' ? importe : 0) - (mov.metodo === 'CASH' ? importe : 0);
        const aTransferencia = d.metodo === 'TRANSFER' && mov.metodo === 'CASH';
        const evidencia = aTransferencia ? (d.operacionId ? 'MERCADOPAGO' : admin ? 'ADMINISTRACION' : null) : null;
        const bloqueo = confirmadoPorMp(mov) ? 'Es un cobro confirmado por Mercado Pago: una corrección no lo reclasifica, cancela ni devuelve. Administración lo resuelve aparte.' : null;
        const revision = permiso.revision ?? (aTransferencia && !evidencia
          ? 'Sin una transferencia verificada en Mercado Pago la revisa administración. Mientras tanto el efectivo esperado no cambia.' : null);
        const cobrado = await this.tickets.collectedAmount(r, m);
        const lineas = [`${ident} · ${pesos(importe)}${importe < mov.monto ? ` de ${pesos(mov.monto)}` : ''}`,
          `Antes: ${MEDIO[mov.metodo]}.`,
          `Después: ${d.metodo === 'CASH' ? 'efectivo' : evidencia === 'MERCADOPAGO' ? 'transferencia verificada en Mercado Pago' : evidencia === 'ADMINISTRACION' ? 'transferencia, aprobada por administración' : 'transferencia (falta verificarla)'}.`,
          `El total cobrado sigue siendo ${pesos(cobrado)}.`,
          ...(efectivo === 0 ? [] : permiso.posteriorAlCierre && permiso.sinContar
            ? ['La caja de ese turno se cerró sola a las 00:00, sin contar: quien la abra cuenta lo que hay y esta corrección explica la diferencia. El ajuste va a la planilla de hoy.']
            : permiso.posteriorAlCierre
            ? ['La caja de ese turno ya se contó: su arqueo no cambia. El ajuste va a la planilla de hoy y queda vinculado a ese cierre.']
            : [`El efectivo esperado de la caja ${efectivo < 0 ? 'baja' : 'sube'} ${pesos(Math.abs(efectivo))}.`])];
        return { ...base, movimientoId: mov.id, permiso, efectivo, digital: -efectivo, bloqueo, revision,
          antes: { metodo: mov.metodo, importe: mov.monto, referencia: mov.referencia },
          despues: { metodo: d.metodo, importe, ...(d.operacionId ? { operacionId: d.operacionId } : {}) }, lineas,
          aplicar: async (c, tx) => {
            let referencia = 'Corrección de medio de pago';
            if (aTransferencia && d.operacionId) {
              const ev = await this.verificacion.usarEnCorreccion(tx, d.operacionId, { importe, cobradoEl: mov.fechaHora, registrationId: r.id, usuarioId: actor.usuarioId });
              c.evidencia = { tipo: 'MERCADOPAGO', ...ev };
              referencia = `Transferencia MercadoPago ${ev.operacionId}`;
            } else if (aTransferencia) c.evidencia = { tipo: 'ADMINISTRACION', usuarioId: actor.usuarioId };
            // Posterior al cierre: el ajuste no entra a ningún turno (su caja ya se contó).
            const turno = c.posteriorAlCierre ? null : c.imputadaTurnoId;
            const motivo = `Corrección de medio de pago: ${MEDIO[mov.metodo]} → ${MEDIO[d.metodo!]}`;
            const nota = { sourceKey: `correccion:${c.id}`, context: `${ident} · ${pesos(importe)}` };
            await this.movimientos.create({ ticketRegistrationId: r.id, monto: -importe, metodo: mov.metodo, tipo: 'AJUSTE', motivo, usuarioId: actor.usuarioId, correccionId: c.id, nota }, tx, turno);
            await this.movimientos.create({ ticketRegistrationId: r.id, monto: importe, metodo: d.metodo!, tipo: 'AJUSTE', motivo, referencia, usuarioId: actor.usuarioId, correccionId: c.id, verificada: true, nota }, tx, turno);
            if (efectivo) await this.cajas.applyTicketPayment(hoy(), efectivo, tx, turno, actor.usuarioId, 'CORRECCION');
          } };
      }
      case 'RECIBIDO_VUELTO': {
        const mov = await this.cobroDe(m, r.id, d.movimientoId);
        if (mov.metodo !== 'CASH') throw new BadRequestException({ code: 'SIN_EFECTIVO', message: 'Ese cobro no fue en efectivo.' });
        const permiso = await this.permiso(m, { turnoId: mov.turno?.id ?? null, usuarioId: mov.usuario?.id ?? null, fecha: mov.fechaHora }, actor);
        const aplicado = mov.monto - await this.corregidoDelCobro(m, mov.id);
        const vigente = await this.recibidoVigente(m, mov);
        const antes = { efectivoRecibido: vigente.efectivoRecibido, vuelto: vigente.vuelto };
        const nuevo = efectivoDeclarado(aplicado, d.efectivoRecibido ?? undefined)!;
        if (antes.efectivoRecibido === nuevo.efectivoRecibido) throw new BadRequestException({ code: 'SIN_CAMBIOS', message: 'Es lo mismo que ya figura.' });
        return { ...base, movimientoId: mov.id, permiso, antes, despues: { ...nuevo }, lineas: this.lineasRecibido(ident, aplicado, antes, nuevo), revision: permiso.revision };
      }
      case 'IDENTIFICACION': {
        if (!r.departureTime) throw new BadRequestException({ code: 'USAR_CORREGIR_ESTADIA', message: 'La estadía sigue adentro: corregila desde Cobrar salida → Corregir.' });
        if (r.entryMode === 'BARCODE' || r.ticket) throw new BadRequestException({ code: 'SIN_PATENTE', message: 'Es una estadía de tarjeta: no tiene patente para corregir.' });
        const original = (d.patente ?? '').trim().toUpperCase();
        const normalizada = normalizePlate(original);
        if (!normalizada) throw new BadRequestException({ code: 'PATENTE_INVALIDA', message: 'La patente debe tener letras o números.' });
        if (normalizada === r.licensePlateNormalized) throw new BadRequestException({ code: 'SIN_CAMBIOS', message: 'Es la misma patente que figura.' });
        const adentro = await m.getRepository(TicketRegistration).findOne({ where: { licensePlateNormalized: normalizada, departureTime: IsNull() } });
        if (adentro) throw new ConflictException({ code: 'PATENTE_ADENTRO', message: 'Esa patente figura adentro. Si la salida se registró sobre el vehículo equivocado, elegí esa opción.' });
        const permiso = await this.permiso(m, await this.opDeSalida(m, r), actor);
        return { ...base, permiso, revision: permiso.revision,
          antes: { patente: r.licensePlateOriginal, noPlate: r.noPlate }, despues: { patente: original },
          lineas: [`Antes: ${r.licensePlateOriginal || 'sin patente'}.`, `Después: ${original}.`,
            'No cambia el importe ni la tarifa: se cobró lo que correspondía a esa estadía.', 'Los comprobantes muestran la patente corregida.'],
          aplicar: async (_c, tx) => {
            await tx.getRepository(TicketRegistration).update(r.id, { licensePlateOriginal: original, licensePlateNormalized: normalizada,
              licensePlateSearch: toSearchKey(normalizada), noPlate: false });
          } };
      }
      case 'VEHICULO':
        return this.planVehiculo(m, r, d, actor, base);
      case 'OTRO': {
        const op = r.departureTime ? await this.opDeSalida(m, r) : { turnoId: null, usuarioId: null, fecha: null };
        return this.planOtro(d, { ...base, permiso: await this.permiso(m, op, actor) });
      }
      default:
        throw new BadRequestException('Elegí qué hay que corregir.');
    }
  }

  private lineasRecibido(ident: string, aplicado: number, antes: { efectivoRecibido: number | null; vuelto: number | null }, nuevo: { efectivoRecibido: number; vuelto: number }) {
    return [`${ident} · ${pesos(aplicado)} en efectivo`,
      antes.efectivoRecibido == null ? 'Antes: no se había indicado con cuánto pagó.' : `Antes: entregó ${pesos(antes.efectivoRecibido)} · vuelto ${pesos(antes.vuelto ?? 0)}.`,
      `Después: entregó ${pesos(nuevo.efectivoRecibido)} · vuelto ${pesos(nuevo.vuelto)}.`,
      `Es lo declarado: no cambia lo que entró a la caja (sigue ${pesos(aplicado)}).`,
      'Si el vuelto que se dio fue otro, la diferencia aparece al contar la caja.'];
  }

  private planOtro(d: Datos, base: Omit<Plan, 'antes' | 'despues' | 'lineas'>): Plan {
    if (!d.detalle?.trim()) throw new BadRequestException({ code: 'DETALLE_REQUERIDO', message: 'Contá qué estuvo mal.' });
    return { ...base, antes: {}, despues: {}, revision: 'La revisa administración.',
      lineas: ['Queda para revisar: no cambia nada hasta que administración lo resuelva.'] };
  }

  // Vehículo equivocado: se registró la salida (y el cobro) sobre la estadía A, pero el que se fue
  // era B, que sigue figurando adentro. Se resuelve solo cuando es seguro: el cobro de A pasa a B
  // (movimientos vinculados, la plata no cambia), B sale a la hora en que se registró la salida y A
  // vuelve a quedar adentro. Si algo no cierra, queda para revisión con todo el contexto.
  private async planVehiculo(m: EntityManager, a: TicketRegistration, d: Datos, actor: Actor, base: Omit<Plan, 'permiso' | 'antes' | 'despues' | 'lineas'>): Promise<Plan> {
    if (!a.departureTime) throw new BadRequestException({ code: 'SIN_SALIDA', message: 'Esa estadía no tiene la salida registrada.' });
    if (!d.destinoRegistrationId || d.destinoRegistrationId === a.id) throw new BadRequestException({ code: 'DESTINO_REQUERIDO', message: 'Elegí el vehículo que de verdad se fue.' });
    const b = await this.estadiaBloqueada(m, d.destinoRegistrationId);
    if (b.departureTime) throw new ConflictException({ code: 'DESTINO_CERRADO', message: 'Ese vehículo ya tiene la salida registrada.' });
    const salida = salidaDe(a)!;
    const permiso = await this.permiso(m, await this.opDeSalida(m, a), actor);
    const identA = identificacionDe(a), identB = identificacionDe(b);
    const movsA = await m.getRepository(Movimiento).find({ where: { ticketRegistration: { id: a.id } }, relations: ['turno'], order: { sequence: 'ASC' } });
    const pagos = movsA.filter((x) => x.tipo === 'SALDO');
    const pagado = pagos.reduce((s, x) => s + x.monto, 0);
    const bloqueos: string[] = [];
    if (esGratuita(a.modalidad) || esGratuita(b.modalidad)) bloqueos.push('Es una estadía gratuita.');
    if (movsA.some((x) => !['ANTICIPO', 'SALDO'].includes(x.tipo) || x.correccionId)) bloqueos.push(`La salida de ${identA} tiene ajustes, descuentos o correcciones.`);
    if (a.entryMode === 'BARCODE' || a.codeBarTicket) bloqueos.push(`${identA} es una estadía de tarjeta.`);
    // El QR o la transferencia al alias quedan vinculados a A en Mercado Pago y en la caja: no se mueven solos.
    if (pagos.some(confirmadoPorMp)) bloqueos.push(`El cobro de ${identA} lo confirmó Mercado Pago (QR o alias).`);
    if (a.licensePlateNormalized && await m.getRepository(TicketRegistration).exists({ where: { licensePlateNormalized: a.licensePlateNormalized, departureTime: IsNull() } }))
      bloqueos.push(`${identA} ya tiene otra estadía adentro.`);
    const entradaB = dayjs.tz(`${b.entryDay} ${b.entryTime}`, 'YYYY-MM-DD HH:mm:ss', TZ).toDate();
    if (entradaB >= salida) bloqueos.push(`${identB} entró después de la salida registrada.`);
    const [enCurso] = await m.query(`SELECT EXISTS(SELECT 1 FROM cobros_mercadopago WHERE "registrationId" = $1 AND estado = 'PENDIENTE'
      UNION ALL SELECT 1 FROM cobros_transferencia WHERE "registrationId" = $1 AND estado IN ('ESPERANDO', 'REVISION')) AS hay`, [b.id]);
    if (enCurso?.hay) bloqueos.push(`${identB} tiene un QR o una transferencia esperando el pago.`);
    let precioB: number | null = null, cobradoB = 0;
    if (!bloqueos.length) {
      precioB = (await this.tickets.precioAl(b, salida, m)).price;
      cobradoB = await this.tickets.collectedAmount(b, m);
      if (precioB !== cobradoB + pagado)
        bloqueos.push(`Lo cobrado (${pesos(pagado)}) no coincide con lo que correspondía a ${identB} a esa hora (${pesos(precioB - cobradoB)}).`);
    }
    const hora = dayjs(salida).tz(TZ).format('HH:mm');
    const anticipos = movsA.filter((x) => x.tipo === 'ANTICIPO').reduce((s, x) => s + x.monto, 0);
    return { ...base, permiso, destinoRegistrationId: b.id, afectadas: [a.id, b.id],
      revision: permiso.revision, bloqueo: bloqueos.length ? `No se puede resolver sola: ${bloqueos.join(' ')}` : null,
      antes: { salidaDe: identA, salida: salida.toISOString(), cobrado: pagado, operador: a.exitOperatorName, turnoId: a.exitTurnoId, precio: a.price },
      despues: { salidaDe: identB, destinoRegistrationId: b.id, precio: precioB },
      lineas: [`La salida de las ${hora} pasa de ${identA} a ${identB}.`,
        `${identA} vuelve a figurar adentro${anticipos ? ` con su anticipo de ${pesos(anticipos)}` : ''}.`,
        `Los ${pesos(pagado)} cobrados quedan en la estadía de ${identB}.`,
        'La caja y los totales no cambian: es el mismo cobro.'],
      aplicar: async (c, tx) => {
        const motivo = `Corrección: la salida y el cobro eran de ${identB}`;
        const nota = { sourceKey: `correccion:${c.id}`, context: `${identA} → ${identB} · ${pesos(pagado)}` };
        // Cada cobro de la salida pasa a B con el mismo medio y el mismo turno (lo de A se compensa).
        for (const p of pagos) {
          await this.movimientos.create({ ticketRegistrationId: a.id, monto: -p.monto, metodo: p.metodo, tipo: 'AJUSTE', motivo, usuarioId: actor.usuarioId, correccionId: c.id, nota }, tx, p.turno?.id ?? null);
          await this.movimientos.create({ ticketRegistrationId: b.id, monto: p.monto, metodo: p.metodo, tipo: 'SALDO', referencia: p.referencia ?? undefined, usuarioId: actor.usuarioId,
            correccionId: c.id, verificada: true, efectivo: p.metodo === 'CASH' && p.efectivoRecibido != null ? { efectivoRecibido: p.efectivoRecibido, vuelto: p.vuelto ?? 0 } : null }, tx, p.turno?.id ?? null);
        }
        await tx.getRepository(TicketRegistration).update(a.id, { departureDay: null, departureTime: null, exitTurnoId: null, exitOperatorName: null,
          origenSalida: null, price: 0, pricingBreakdown: null, priceBracketLabel: null, appliedPricingDayType: null, exceededExpectedStay: false } as never);
        await this.tickets.cerrarPorCorreccion(tx, b.id, { precio: precioB!, cobrado: precioB! }, actor.usuarioId, salida, { turnoId: a.exitTurnoId, operador: a.exitOperatorName });
      } };
  }

  // ------------------------------------------------------------------ crear, previsualizar, resolver

  private async versionDe(m: EntityManager, d: { registrationId?: string | null; paseId?: string | null }) {
    return d.paseId ? this.versionPase(m, d.paseId) : this.versionEstadia(m, d.registrationId!);
  }

  private estadoDe(plan: Plan, tipo: TipoCorreccion, actor: Actor): EstadoCorreccion {
    if (plan.bloqueo || tipo === 'OTRO') return 'PENDIENTE';
    if (esAdministracion(actor.rol)) return 'APLICADA';
    return plan.permiso.directo && !plan.revision ? 'APLICADA' : 'PENDIENTE';
  }

  private efectoDe(plan: Plan, estado: EstadoCorreccion) {
    const pendiente = estado === 'PENDIENTE';
    return { lineas: [...plan.lineas, ...(pendiente ? [plan.bloqueo ?? plan.revision ?? 'La revisa administración.', 'Queda pendiente: no cambia nada hasta que administración la revise.'] : [])],
      efectivo: pendiente ? 0 : plan.efectivo, digital: pendiente ? 0 : plan.digital, identificacion: plan.identificacion,
      posteriorAlCierre: plan.permiso.posteriorAlCierre };
  }

  /** Lo que haría la corrección, sin guardarla: el resumen que se confirma. */
  async previsualizar(dto: CorreccionDto, actor: Actor) {
    return operationTransaction(this.ds, async (m) => {
      const version = await this.versionDe(m, dto);
      if (version !== dto.version) throw this.cambio();
      const plan = await this.planificar(m, dto, actor);
      const estado = this.estadoDe(plan, dto.tipo, actor);
      return { estado, efecto: this.efectoDe(plan, estado), antes: plan.antes, despues: plan.despues, motivoRevision: estado === 'PENDIENTE' ? plan.bloqueo ?? plan.revision : null };
    });
  }

  private cambio() {
    return new ConflictException({ code: 'OPERACION_CAMBIO', message: 'La operación cambió mientras la corregías (otro cobro, otra corrección). Revisala de nuevo.' });
  }

  async crear(dto: CorreccionDto, actor: Actor) {
    const resultado = await operationTransaction(this.ds, async (m) => {
      // El bloqueo de caja de cobros y cierres: nada se cruza con un cobro o un arqueo en curso, ni
      // dos envíos de la misma corrección.
      await m.query('SELECT pg_advisory_xact_lock(718904)');
      // Si pasaron las 00:00 y el corte todavía no corrió, se hace antes de elegir a qué tramo va el efecto.
      await rolloverShifts(m);
      // Un doble toque o un reintento: la misma corrección, sin aplicarla dos veces.
      const previa = await m.getRepository(Correccion).findOne({ where: { solicitudId: dto.solicitudId } });
      if (previa) {
        if (previa.usuarioId !== actor.usuarioId) throw new ConflictException('Ese identificador ya se usó.');
        return { correccion: previa, afectadas: [] as string[] };
      }
      if (!dto.registrationId === !dto.paseId) throw new BadRequestException('Indicá una sola operación a corregir.');
      const version = await this.versionDe(m, dto);
      if (version !== dto.version) throw this.cambio();
      const plan = await this.planificar(m, dto, actor);
      const estado = this.estadoDe(plan, dto.tipo, actor);
      const repo = m.getRepository(Correccion);
      const nombre = await this.nombre(m, actor.usuarioId);
      const ahora = operationNow();
      const c = await this.guardarNueva(repo, {
        solicitudId: dto.solicitudId, tipo: dto.tipo, estado, registrationId: plan.registrationId, paseId: plan.paseId, movimientoId: plan.movimientoId,
        destinoRegistrationId: plan.destinoRegistrationId, turnoId: plan.permiso.turnoId,
        imputadaTurnoId: estado === 'APLICADA' && !plan.permiso.posteriorAlCierre ? plan.permiso.imputadaTurnoId : null,
        posteriorAlCierre: estado === 'APLICADA' && plan.permiso.posteriorAlCierre, usuarioId: actor.usuarioId, usuarioNombre: nombre,
        motivo: dto.motivo, detalle: dto.detalle?.trim() || null, antes: plan.antes, despues: plan.despues, efecto: this.efectoDe(plan, estado),
        evidencia: null, aplicadaEl: estado === 'APLICADA' ? ahora : null,
        // Administración aplica como quien revisa.
        ...(estado === 'APLICADA' && esAdministracion(actor.rol) ? { revisadoPor: actor.usuarioId, revisadoPorNombre: nombre, revisadoEl: ahora } : {}),
      });
      if (estado === 'APLICADA' && plan.aplicar) {
        await plan.aplicar(c, m);
        await repo.save(c);
      }
      await this.publicar(m, c, actor);
      return { correccion: c, afectadas: plan.afectadas.length ? plan.afectadas : [plan.registrationId].filter(Boolean) as string[] };
    });
    await this.avisar(resultado.afectadas);
    return this.vista(resultado.correccion);
  }

  // El identificador de la solicitud es único en toda la base y la búsqueda previa solo ve esta
  // playa: si coincidiera con uno de otra playa, se informa como conflicto, no como un error interno.
  private async guardarNueva(repo: import('typeorm').Repository<Correccion>, datos: Partial<Correccion>) {
    try {
      return await repo.save(repo.create(datos));
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') throw new ConflictException({ code: 'SOLICITUD_REPETIDA', message: 'Ese identificador ya se usó. Abrí la corrección de nuevo.' });
      throw error;
    }
  }

  async resolver(id: string, dto: ResolverCorreccionDto, actor: Actor) {
    if (!esAdministracion(actor.rol)) throw new ForbiddenException('Las correcciones las revisa administración.');
    const resultado = await operationTransaction(this.ds, async (m) => {
      await m.query('SELECT pg_advisory_xact_lock(718904)');
      await rolloverShifts(m);
      const repo = m.getRepository(Correccion);
      const c = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!c) throw new NotFoundException('Corrección no encontrada.');
      if (c.estado !== 'PENDIENTE') throw new ConflictException({ code: 'YA_RESUELTA', message: 'Esa corrección ya se resolvió.' });
      if (!dto.resolucion?.trim()) throw new BadRequestException({ code: 'RESOLUCION_REQUERIDA', message: 'Escribí cómo se resolvió.' });
      const nombre = await this.nombre(m, actor.usuarioId);
      const ahora = operationNow();
      Object.assign(c, { revisadoPor: actor.usuarioId, revisadoPorNombre: nombre, revisadoEl: ahora, resolucion: dto.resolucion.trim() });
      let afectadas: string[] = [];
      if (dto.accion === 'RECHAZAR') c.estado = 'RECHAZADA';
      else if (c.tipo === 'OTRO') { c.estado = 'APLICADA'; c.aplicadaEl = ahora; }
      else {
        if (dto.version && dto.version !== await this.versionDe(m, c)) throw this.cambio();
        const despues = c.despues as Record<string, any>;
        const plan = await this.planificar(m, {
          tipo: c.tipo, registrationId: c.registrationId ?? undefined, paseId: c.paseId ?? undefined, movimientoId: c.movimientoId ?? undefined,
          destinoRegistrationId: c.destinoRegistrationId ?? undefined, motivo: c.motivo, detalle: c.detalle ?? undefined,
          patente: despues.patente, metodo: despues.metodo, importe: despues.importe, efectivoRecibido: despues.efectivoRecibido,
          operacionId: dto.operacionId ?? despues.operacionId,
        }, actor, c.id);
        if (plan.bloqueo) throw new ConflictException({ code: 'CORRECCION_NO_APLICABLE', message: `${plan.bloqueo} Resolvela a mano y marcala como rechazada con lo que se hizo.` });
        Object.assign(c, { estado: 'APLICADA', aplicadaEl: ahora, antes: plan.antes, despues: plan.despues, efecto: this.efectoDe(plan, 'APLICADA'),
          imputadaTurnoId: plan.permiso.posteriorAlCierre ? null : plan.permiso.imputadaTurnoId, posteriorAlCierre: plan.permiso.posteriorAlCierre });
        await plan.aplicar?.(c, m);
        afectadas = plan.afectadas.length ? plan.afectadas : [plan.registrationId].filter(Boolean) as string[];
      }
      await repo.save(c);
      await this.publicar(m, c, actor);
      return { correccion: c, afectadas };
    });
    await this.avisar(resultado.afectadas);
    return this.vista(resultado.correccion);
  }

  // La nota en Avisos, vinculada a la operación: para revisar mientras está pendiente.
  private async publicar(m: EntityManager, c: Correccion, actor: Actor) {
    const efecto = c.efecto as { lineas?: string[]; identificacion?: string };
    const titulo: Record<TipoCorreccion, string> = { IDENTIFICACION: 'Patente', MEDIO_PAGO: 'Medio de pago', RECIBIDO_VUELTO: 'Recibido y vuelto', VEHICULO: 'Vehículo equivocado', OTRO: 'Otro error' };
    const estado = { APLICADA: 'aplicada', PENDIENTE: 'pendiente de revisión', RECHAZADA: 'rechazada' }[c.estado];
    await publishAutomaticNote(m, {
      sourceKey: `correccion:${c.id}`, origin: 'Corrección de registro', sourceType: 'TICKET', sourceId: c.registrationId ?? c.paseId ?? c.id,
      usuarioId: actor.usuarioId, paraRevisar: c.estado === 'PENDIENTE' || (c.estado === 'APLICADA' && Number((c.efecto as any).efectivo ?? 0) !== 0 && !esAdministracion(actor.rol)),
      context: `${efecto.identificacion ?? ''} · ${titulo[c.tipo]} · ${estado}`,
      description: [`${titulo[c.tipo]} (${estado}).`, c.detalle, ...(efecto.lineas ?? []), c.resolucion ? `Resolución: ${c.resolucion}` : null].filter(Boolean).join('\n'),
    });
  }

  private async avisar(ids: string[]) {
    for (const id of ids) {
      const r = await this.ds.getRepository(TicketRegistration).findOne({ where: { id } });
      if (r) this.tickets.emitirRegistro(r);
    }
  }

  vista(c: Correccion) {
    return { id: c.id, solicitudId: c.solicitudId, tipo: c.tipo, estado: c.estado, registrationId: c.registrationId, paseId: c.paseId,
      movimientoId: c.movimientoId, destinoRegistrationId: c.destinoRegistrationId, turnoId: c.turnoId, imputadaTurnoId: c.imputadaTurnoId,
      posteriorAlCierre: c.posteriorAlCierre, usuarioNombre: c.usuarioNombre, motivo: c.motivo, detalle: c.detalle, antes: c.antes, despues: c.despues,
      efecto: c.efecto, evidencia: c.evidencia ? { tipo: (c.evidencia as any).tipo, operacionId: (c.evidencia as any).operacionId ?? null } : null,
      revisadoPorNombre: c.revisadoPorNombre, revisadoEl: c.revisadoEl, resolucion: c.resolucion, aplicadaEl: c.aplicadaEl, createdAt: c.createdAt };
  }

  /**
   * Las transferencias que pueden respaldar el cambio de un cobro en efectivo a transferencia. Muestran
   * quién pagó: solo las ve quien puede aplicar esa corrección (su operación del turno abierto, o
   * administración) y por un importe que no supere lo que queda por corregir de ese cobro. Lo demás
   * queda para revisión y la transferencia la busca administración.
   */
  async transferenciasPara(movimientoId: string, importe: number | undefined, actor: Actor) {
    const { mov, restante } = await operationTransaction(this.ds, async (m) => {
      const mov = await m.getRepository(Movimiento).findOne({ where: { id: movimientoId }, relations: ['turno', 'usuario'] });
      if (!mov || mov.metodo !== 'CASH' || !['SALDO', 'ANTICIPO'].includes(mov.tipo) || !(mov.monto > 0) || mov.correccionId)
        throw new NotFoundException('Ese cobro en efectivo no existe.');
      const permiso = await this.permiso(m, { turnoId: mov.turno?.id ?? null, usuarioId: mov.usuario?.id ?? null, fecha: mov.fechaHora }, actor);
      if (!permiso.directo) throw new ForbiddenException({ code: 'TRANSFERENCIA_LA_BUSCA_ADMINISTRACION', message: 'Esta corrección la revisa administración: ella busca la transferencia.' });
      return { mov, restante: mov.monto - await this.corregidoDelCobro(m, mov.id) };
    });
    if (restante <= 0) throw new ConflictException({ code: 'YA_CORREGIDO', message: 'Ese cobro ya se corrigió por completo.' });
    if (importe !== undefined && importe > restante) throw new BadRequestException({ code: 'IMPORTE_MAYOR', message: `De ese cobro queda ${pesos(restante)} por corregir.` });
    return this.verificacion.candidatasParaCorreccion(importe ?? restante, mov.fechaHora);
  }

  // ------------------------------------------------------------------ detalle

  /** Todo de una estadía para el historial y para corregirla: cobros vigentes, ajustes y correcciones. */
  async detalleEstadia(id: string, actor: Actor) {
    return operationTransaction(this.ds, async (m) => {
      const r = await m.getRepository(TicketRegistration).findOne({ where: { id }, relations: ['ticket'] });
      if (!r) throw new NotFoundException('Registro no encontrado.');
      const movs = await m.getRepository(Movimiento).find({ where: { ticketRegistration: { id } }, relations: ['usuario', 'turno'], order: { sequence: 'ASC' } });
      const correcciones = await m.getRepository(Correccion).find({ where: [{ registrationId: id }, { destinoRegistrationId: id }], order: { createdAt: 'DESC' } });
      const operador = (u?: { firstName?: string; lastName?: string; username?: string } | null) => u ? (`${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.username || null) : null;
      const pagos = [];
      for (const mov of movs.filter((x) => ['SALDO', 'ANTICIPO'].includes(x.tipo) && x.monto > 0)) {
        const movido = await this.movidoPorVehiculo(m, mov, id);
        const permiso = await this.permiso(m, { turnoId: mov.turno?.id ?? null, usuarioId: mov.usuario?.id ?? null, fecha: mov.fechaHora }, actor);
        const vigente = mov.metodo === 'CASH' ? await this.recibidoVigente(m, mov) : { efectivoRecibido: null, vuelto: null, corregido: false };
        pagos.push({ id: mov.id, tipo: mov.tipo, metodo: mov.metodo, monto: mov.monto, fecha: mov.fechaHora, operador: operador(mov.usuario), turnoId: mov.turno?.id ?? null,
          efectivoRecibido: vigente.efectivoRecibido, vuelto: vigente.vuelto, recibidoCorregido: vigente.corregido,
          corregido: await this.corregidoDelCobro(m, mov.id), confirmadoPorMp: confirmadoPorMp(mov), directo: permiso.directo, motivoRevision: permiso.revision,
          // Pasó a otra estadía (vehículo equivocado) o llegó de otra: el original y su corrección.
          movido, deCorreccion: !!mov.correccionId });
      }
      const medios: Record<string, number> = {};
      for (const mov of movs) if (mov.tipo !== 'CORTESIA' && mov.tipo !== 'DESCUENTO') medios[mov.metodo] = (medios[mov.metodo] ?? 0) + mov.monto;
      const salida = salidaDe(r);
      const permisoSalida = salida ? await this.permiso(m, await this.opDeSalida(m, r), actor) : null;
      const entrada = dayjs.tz(`${r.entryDay} ${r.entryTime}`, 'YYYY-MM-DD HH:mm:ss', TZ).toDate();
      return { tipo: 'ESTADIA' as const, id: r.id, identificacion: identificacionDe(r), patente: r.licensePlateOriginal, vehicleType: r.vehicleType ?? r.ticket?.vehicleType ?? null,
        entrada: entrada.toISOString(), salida: salida?.toISOString() ?? null, entryOperatorName: r.entryOperatorName, exitOperatorName: r.exitOperatorName,
        exitTurnoId: r.exitTurnoId, precio: salida ? r.price : null, cobrado: Object.values(medios).reduce((s, n) => s + n, 0),
        medios: Object.fromEntries(Object.entries(medios).filter(([, n]) => n !== 0)), pagos,
        ajustes: movs.filter((x) => !['SALDO', 'ANTICIPO'].includes(x.tipo) || x.monto < 0).map((x) => ({ id: x.id, tipo: x.tipo, metodo: x.metodo, monto: x.monto,
          motivo: x.motivo, fecha: x.fechaHora, correccionId: x.correccionId, operador: operador(x.usuario) })),
        correcciones: correcciones.map((c) => this.vista(c)), version: await this.versionEstadia(m, id),
        permiso: permisoSalida ? { directo: permisoSalida.directo, motivoRevision: permisoSalida.revision } : null,
        comprobantes: { entrada: true, salida: !!salida } };
    });
  }

  async detallePase(id: string, actor: Actor) {
    return operationTransaction(this.ds, async (m) => {
      const p = await m.getRepository(TicketRegistrationForDay).findOne({ where: { id } });
      if (!p) throw new NotFoundException('Estadía no encontrada.');
      const correcciones = await m.getRepository(Correccion).find({ where: { paseId: id }, order: { createdAt: 'DESC' } });
      const [c] = await m.query(`SELECT despues FROM correcciones WHERE "paseId" = $1 AND tipo = 'RECIBIDO_VUELTO' AND estado = 'APLICADA' ORDER BY "aplicadaEl" DESC LIMIT 1`, [id]);
      const nombre = await this.nombre(m, actor.usuarioId);
      const directo = esAdministracion(actor.rol) || (!!nombre && p.paymentOperatorName === nombre && dayjs(p.createdAt).tz(TZ).format('YYYY-MM-DD') === hoy());
      return { tipo: 'PASE' as const, id: p.id, identificacion: p.vehiclePlateCustomer || p.lastNameCustomer || 'Sin patente', ticketTimeType: p.ticketTimeType,
        alta: p.createdAt, retiro: p.retiredAt, precio: p.price, pagado: !!p.paid, metodo: p.paid ? p.paymentMetodo ?? 'CASH' : null,
        efectivoRecibido: c ? Number(c.despues.efectivoRecibido) : p.efectivoRecibido, vuelto: c ? Number(c.despues.vuelto) : p.vuelto, recibidoCorregido: !!c,
        entryOperatorName: p.entryOperatorName, paymentOperatorName: p.paymentOperatorName, exitOperatorName: p.exitOperatorName,
        correcciones: correcciones.map((x) => this.vista(x)), version: await this.versionPase(m, id),
        permiso: { directo, motivoRevision: directo ? null : 'La revisa administración: es de otro operador o de otro día.' } };
    });
  }
}
