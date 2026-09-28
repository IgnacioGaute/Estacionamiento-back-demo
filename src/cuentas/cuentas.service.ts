import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import dayjs from 'dayjs';
import { tenantContext } from 'src/tenancy/tenant-context';
import { Customer } from 'src/customers/entities/customer.entity';
import { Receipt } from 'src/receipts/entities/receipt.entity';
import { ReceiptPayment } from 'src/receipts/entities/receipt-payment.entity';
import { ReceiptsService } from 'src/receipts/receipts.service';
import { BoxListsService } from 'src/box-lists/box-lists.service';
import { CuentaMetodo, CuentaMovimiento } from './entities/cuenta-movimiento.entity';
import { ParkingReceipt, ReciboPagoSnapshot } from 'src/tickets/entities/parking-receipt.entity';
import { Playa } from 'src/tenancy/entities/playa.entity';
import { randomBytes } from 'node:crypto';
import { AjusteDto, DevolucionDto, RegistrarPagoDto, SaldoInicialDto } from './dto/cuentas.dto';
import { contextoAnulacion, reglaAnulacion } from './anulacion';
import {
  asegurarCuenta,
  asentar,
  bloquearCliente,
  cargosDe,
  conceptoDeRecibo,
  conciliar,
  deshacerImputaciones,
  diaDeVencimiento,
  fechaDeRecibo,
  hoy,
  mesLargo,
  pagosRealesDe,
  plataTexto,
  saldoDe,
  vencimientoDe,
  yaAnulado,
} from './libro';

// Tener saldo pendiente no es estar atrasado: lo que se debe está «pendiente» hasta su
// vencimiento y recién después «vencido». Lo vencido se agrupa por días desde que venció.
type Tramo = 'PENDIENTE' | 'VENCIDO_30' | 'VENCIDO_60' | 'VENCIDO_MAS';
const TRAMOS: Tramo[] = ['PENDIENTE', 'VENCIDO_30', 'VENCIDO_60', 'VENCIDO_MAS'];

function tramoDe(vencimiento: string, hoyStr: string): Tramo {
  if (vencimiento >= hoyStr) return 'PENDIENTE';
  const dias = dayjs(hoyStr).diff(dayjs(vencimiento), 'day');
  return dias <= 30 ? 'VENCIDO_30' : dias <= 60 ? 'VENCIDO_60' : 'VENCIDO_MAS';
}

const fechaAR = (f: string) => dayjs(f).format('DD/MM/YYYY');
const diaAR = (d: Date | string) => dayjs(d).tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD');

// Solo el mes en curso o el siguiente: más atrás es deuda vieja (saldo inicial) y más adelante
// es adivinar altas, bajas y precios.
function validarMesDeAbono(mes: string) {
  const actual = hoy().slice(0, 7);
  const siguiente = dayjs(`${actual}-01`).add(1, 'month').format('YYYY-MM');
  if (mes !== actual && mes !== siguiente)
    throw new BadRequestException(`Solo se cargan los abonos de ${mesLargo(actual)} o de ${mesLargo(siguiente)}.`);
}

// Vencimiento guardado en el cargo; los viejos sin él usan su fecha.
const vencimientoDeCargo = (r: { vencimiento?: string | null; startDate?: string | null; dateNow?: string | null }) =>
  String(r.vencimiento ?? r.startDate ?? r.dateNow ?? '').slice(0, 10);

const nombreDeMedio = (metodo: string | null) =>
  ({ CASH: 'Efectivo', TRANSFER: 'Transferencia', CHECK: 'Cheque', MERCADOPAGO: 'MercadoPago' })[metodo ?? ''] ?? 'Otro';

// Número para abrir WhatsApp: solo dígitos, como los tickets. Un celular argentino cargado sin
// código de país (10 dígitos, o con el 0 adelante) se completa con 549; si no, va tal cual.
function telefonoParaWhatsapp(telefono: string | null | undefined) {
  let digitos = (telefono ?? '').replace(/\D/g, '');
  if (digitos.length === 11 && digitos.startsWith('0')) digitos = digitos.slice(1);
  if (digitos.length === 10) digitos = `549${digitos}`;
  return digitos.length >= 10 ? digitos : null;
}

function agruparPorRecibo<T extends { receiptId: string; aplicado: number }>(lineas: T[]): T[] {
  const porRecibo = new Map<string, T>();
  for (const l of lineas) {
    const actual = porRecibo.get(l.receiptId);
    porRecibo.set(l.receiptId, actual ? { ...actual, aplicado: actual.aplicado + l.aplicado } : { ...l });
  }
  return [...porRecibo.values()];
}

// La cuenta corriente de los inquilinos: cobros en fracciones, saldo inicial, ajustes y
// anulaciones, siempre como asientos nuevos del libro (ver libro.ts). Cada operación corre en
// una sola transacción: el libro, los recibos y la caja se mueven juntos o no se mueven.
@Injectable()
export class CuentasService {
  constructor(
    private readonly ds: DataSource,
    private readonly receipts: ReceiptsService,
    private readonly boxLists: BoxListsService,
  ) {}

  // La sección se prende por playa desde la plataforma. Apagada, ni se lee ni se cobra.
  async asegurarModulo() {
    const playaId = tenantContext.getStore()?.playaId;
    if (!playaId) throw new ForbiddenException('Elegí una playa.');
    const [playa] = await this.ds.query('SELECT modulos FROM playas WHERE id = $1', [playaId]);
    if (!playa?.modulos?.inquilinos)
      throw new ForbiddenException({
        code: 'MODULO_INQUILINOS_APAGADO',
        message: 'La sección de inquilinos no está habilitada en esta playa.',
      });
    return playaId as string;
  }

  private async inquilino(manager: EntityManager, customerId: string) {
    const customer = await manager.findOne(Customer, {
      where: { id: customerId },
      relations: ['parkingRenters', 'parkingRenters.parkingOwner', 'parkingRenters.parkingOwner.customer'],
      withDeleted: true,
    });
    if (!customer || customer.customerType !== 'RENTER')
      throw new NotFoundException('Inquilino no encontrado en esta playa.');
    return customer;
  }

  // ------------------------------------------------------------------ lectura

  async resumen() {
    await this.asegurarModulo();
    return this.ds.transaction(async (m) => {
      // Los dados de baja también: dejar de alquilar no cancela lo que se debe, y sus pagos
      // cuentan en lo cobrado del mes.
      const clientes = await m.find(Customer, {
        where: { customerType: 'RENTER' },
        relations: ['parkingRenters'],
        order: { lastName: 'ASC', firstName: 'ASC' },
        withDeleted: true,
      });
      const ids = clientes.map((c) => c.id);
      const hoyStr = hoy();
      const mes = hoyStr.slice(0, 7);

      // Los que todavía no tienen libro se vuelcan acá, así la lista ya muestra saldos reales.
      const conLibro = new Set<string>(
        (await m.query('SELECT DISTINCT "customerId" FROM cuenta_movimientos WHERE "customerId" = ANY($1)', [ids])).map(
          (f: any) => f.customerId,
        ),
      );
      for (const c of clientes) if (!conLibro.has(c.id)) await asegurarCuenta(m, c.id);

      // En serie: dentro de una transacción todas comparten la misma conexión.
      const consultas = [
        () => m.query(
          'SELECT "customerId", SUM(importe)::bigint AS saldo FROM cuenta_movimientos WHERE "customerId" = ANY($1) GROUP BY "customerId"',
          [ids],
        ),
        // Pagos no anulados, agrupados por recibo de pago.
        () => m.query(
          `SELECT p."customerId", p.numero, to_char(p.fecha, 'YYYY-MM-DD') AS fecha, SUM(-p.importe)::bigint AS total
           FROM cuenta_movimientos p
           WHERE p."customerId" = ANY($1) AND p.tipo = 'PAGO'
             AND NOT EXISTS (SELECT 1 FROM cuenta_movimientos a WHERE a."anulaId" = p.id)
           GROUP BY p."customerId", p.numero, p.fecha
           ORDER BY p.fecha DESC`,
          [ids],
        ),
        // Lo que falta pagar de cada cargo, con su vencimiento.
        () => m.query(
          `SELECT r."customerId", r.price,
                  to_char(COALESCE(r.vencimiento, r."startDate", r."dateNow"), 'YYYY-MM-DD') AS vencimiento
           FROM receipts r
           WHERE r."customerId" = ANY($1) AND r.status = 'PENDING' AND r."deletedAt" IS NULL AND r.price > 0`,
          [ids],
        ),
        // El abono del mes: cuánto se cargó y cuánto sigue sin saldar. Es la cobranza del período,
        // que no se mezcla con lo cobrado de deudas viejas o de adelantos.
        () => m.query(
          `SELECT COALESCE(SUM(r."startAmount"), 0)::bigint AS cargado,
                  COALESCE(SUM(CASE WHEN r.status = 'PENDING' THEN r.price ELSE 0 END), 0)::bigint AS pendiente,
                  COUNT(*)::int AS cantidad
           FROM receipts r
           WHERE r."tipoCargo" = 'ABONO' AND r.periodo = $1 AND r."deletedAt" IS NULL`,
          [mes],
        ),
        // Anulaciones hechas este mes; un pago con varios medios cuenta como una.
        () => m.query(
          `SELECT COUNT(DISTINCT COALESCE(a."customerId"::text || ':' || a.numero, a.id::text))::int AS total
           FROM cuenta_movimientos a
           WHERE a.tipo = 'ANULACION'
             AND to_char(a."createdAt" AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM') = $1`,
          [mes],
        ),
      ];
      const resultados: any[][] = [];
      for (const consulta of consultas) resultados.push(await consulta());
      const [saldos, pagos, pendientes, abonoMes, anulaciones] = resultados;

      const saldoDeCliente = new Map<string, number>(saldos.map((f: any) => [f.customerId, Number(f.saldo)]));
      const ultimoPago = new Map<string, { fecha: string; importe: number }>();
      let cobradoMes = 0;
      for (const p of pagos) {
        if (!ultimoPago.has(p.customerId)) ultimoPago.set(p.customerId, { fecha: p.fecha, importe: Number(p.total) });
        if (p.fecha.slice(0, 7) === mes) cobradoMes += Number(p.total);
      }
      const deudaDe = new Map<string, { cargos: number; vencido: number; vencidoDesde: string | null }>();
      for (const r of pendientes) {
        const actual = deudaDe.get(r.customerId) ?? { cargos: 0, vencido: 0, vencidoDesde: null };
        actual.cargos += 1;
        if (r.vencimiento < hoyStr) {
          actual.vencido += Number(r.price);
          if (!actual.vencidoDesde || r.vencimiento < actual.vencidoDesde) actual.vencidoDesde = r.vencimiento;
        }
        deudaDe.set(r.customerId, actual);
      }

      const inquilinos = clientes.map((c) => {
        const saldo = saldoDeCliente.get(c.id) ?? 0;
        const deuda = deudaDe.get(c.id);
        const baja = c.deletedAt ? diaAR(c.deletedAt) : null;
        // Las cocheras de un dado de baja ya se liberaron: se muestran igual para reconocerlo.
        const cocheras = (c.parkingRenters ?? []).filter((r) => baja || !r.deletedAt);
        const vencido = saldo > 0 ? Math.min(saldo, deuda?.vencido ?? 0) : 0;
        return {
          id: c.id,
          nombre: c.firstName,
          apellido: c.lastName,
          telefono: c.phone ?? null,
          cocheras: cocheras.map((r) => r.garageNumber).filter(Boolean),
          patentes: cocheras.map((r) => r.licensePlate).filter(Boolean),
          abono: baja ? 0 : cocheras.reduce((s, r) => s + (r.amount ?? 0), 0),
          baja,
          saldo,
          vencido,
          vencidoDesde: vencido > 0 ? (deuda?.vencidoDesde ?? null) : null,
          estado: saldo < 0 ? 'A_FAVOR' : saldo === 0 ? 'AL_DIA' : vencido > 0 ? 'VENCIDO' : 'PENDIENTE',
          tramo: (saldo <= 0 ? null : vencido > 0 ? tramoDe(deuda!.vencidoDesde!, hoyStr) : 'PENDIENTE') as Tramo | null,
          cargosPendientes: deuda?.cargos ?? 0,
          ultimoPago: ultimoPago.get(c.id) ?? null,
        };
      });
      const activos = inquilinos.filter((i) => !i.baja);

      return {
        kpis: {
          activos: activos.length,
          bajas: inquilinos.length - activos.length,
          conSaldo: inquilinos.filter((i) => i.saldo > 0).length,
          conVencido: inquilinos.filter((i) => i.vencido > 0).length,
          saldoPendiente: inquilinos.reduce((s, i) => s + Math.max(0, i.saldo), 0),
          deudaVencida: inquilinos.reduce((s, i) => s + i.vencido, 0),
          aFavorTotal: inquilinos.reduce((s, i) => s + Math.max(0, -i.saldo), 0),
          cobradoMes,
          abonoMes: {
            cargado: Number(abonoMes[0]?.cargado ?? 0),
            pendiente: Number(abonoMes[0]?.pendiente ?? 0),
            cantidad: Number(abonoMes[0]?.cantidad ?? 0),
          },
          abonoMensual: activos.reduce((s, i) => s + i.abono, 0),
          anulacionesMes: Number(anulaciones[0]?.total ?? 0),
        },
        inquilinos,
      };
    });
  }

  async estado(customerId: string) {
    await this.asegurarModulo();
    return this.ds.transaction(async (m) => {
      const c = await this.inquilino(m, customerId);
      await asegurarCuenta(m, customerId);

      const filas = await m.find(CuentaMovimiento, {
        where: { customerId },
        order: { fecha: 'ASC', sequence: 'ASC' },
      });
      const ctx = await contextoAnulacion(m, customerId, filas);
      const anulados = ctx.anulados;
      const usuarios = new Map<string, string>(
        (
          await m.query('SELECT id, "firstName", "lastName" FROM users WHERE id = ANY($1)', [
            [...new Set(filas.map((f) => f.usuarioId).filter(Boolean))],
          ])
        ).map((u: any) => [u.id, `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim()]),
      );
      // Un asiento anulado y su anulación suman cero: sin ellos el saldo acumulado sigue cerrando,
      // y es el que ve el inquilino (ver anulacion.ts).
      let acumulado = 0;
      let acumuladoSinAnulados = 0;
      const movimientos = filas.map((f) => {
        acumulado += f.importe;
        const anulado = anulados.has(f.id);
        if (!anulado && f.tipo !== 'ANULACION') acumuladoSinAnulados += f.importe;
        return {
          id: f.id,
          fecha: String(f.fecha).slice(0, 10),
          creado: f.createdAt,
          tipo: f.tipo,
          concepto: f.concepto,
          debe: f.importe > 0 ? f.importe : 0,
          haber: f.importe < 0 ? -f.importe : 0,
          saldo: acumulado,
          saldoSinAnulados: acumuladoSinAnulados,
          metodo: f.metodo,
          numero: f.numero,
          motivo: f.motivo,
          receiptId: f.receiptId,
          anulado,
          anulaId: f.anulaId,
          usuario: f.usuarioId ? (usuarios.get(f.usuarioId) ?? null) : null,
          migrado: !!(f.detalle as any)?.migrado,
          anulable: reglaAnulacion(f, ctx),
        };
      });
      const porId = new Map(filas.map((f) => [f.id, f]));

      const hoyStr = hoy();
      const recibosDb = await m.find(Receipt, {
        ...cargosDe(customerId),
        relations: ['payments'],
        order: { startDate: 'DESC', createdAt: 'DESC' },
      });
      // Cargos de la cuenta (en la base siguen siendo `receipts`). Lo aplicado a cada uno se
      // separa: plata recibida, descuentos (bonificaciones) y saldo a favor que se usó. Contar
      // un descuento como «pagado» mostraría plata que nunca entró.
      const recibos = recibosDb.map((r) => {
        const pagos = (r.payments ?? []).sort((a, b) => String(a.paymentDate).localeCompare(String(b.paymentDate)));
        const suma = (filtro: (tipo: string) => boolean) =>
          pagos.filter((p) => filtro(p.paymentType)).reduce((s, p) => s + (p.price ?? 0), 0);
        const bonificado = suma((t) => t === 'FIX');
        const aFavorAplicado = suma((t) => t === 'CREDIT');
        const pagado = suma((t) => t !== 'FIX' && t !== 'CREDIT');
        const saldo = r.price ?? 0;
        const vencimiento = vencimientoDeCargo(r);
        // Anular un cargo es anular el asiento que lo creó.
        const origen = porId.get(ctx.origenes.get(r.id) ?? '');
        return {
          id: r.id,
          numero: r.receiptNumber,
          concepto: conceptoDeRecibo(r),
          tipoCargo: r.tipoCargo,
          periodo: r.periodo,
          fecha: fechaDeRecibo(r),
          vencimiento,
          vencido: saldo > 0 && vencimiento < hoyStr,
          total: saldo + pagado + bonificado + aFavorAplicado,
          pagado,
          bonificado,
          aFavorAplicado,
          saldo,
          estado: r.status,
          situacion: saldo <= 0 ? 'SALDADO' : pagado + bonificado + aFavorAplicado > 0 ? 'PARCIAL' : 'PENDIENTE',
          origen: origen && origen.importe > 0 ? { id: origen.id, importe: origen.importe, anulable: reglaAnulacion(origen, ctx) } : null,
          pagos: pagos.map((p) => ({
            fecha: p.paymentDate,
            tipo: p.paymentType,
            importe: p.price ?? 0,
            cuentaMovimientoId: p.cuentaMovimientoId,
          })),
        };
      });

      // Comprobantes de pago: las filas de un mismo número son un solo cobro con varios medios.
      const comprobantes = new Map<string, any>();
      for (const f of filas.filter((x) => x.tipo === 'PAGO')) {
        const clave = f.numero ?? f.id;
        const actual = comprobantes.get(clave) ?? {
          id: f.id,
          numero: f.numero,
          fecha: String(f.fecha).slice(0, 10),
          total: 0,
          medios: [] as { metodo: string | null; importe: number }[],
          anulado: false,
          usuario: f.usuarioId ? (usuarios.get(f.usuarioId) ?? null) : null,
          nota: f.motivo,
          migrado: !!(f.detalle as any)?.migrado,
          // Cómo quedó la cuenta al cobrar (null en cobros migrados, que no lo guardaron).
          saldoDespues: ((f.detalle as any)?.saldoDespues ?? null) as number | null,
          imputaciones: [] as { receiptId: string; aplicado: number; resta?: number }[],
          anulable: reglaAnulacion(f, ctx),
        };
        actual.total += -f.importe;
        actual.medios.push({ metodo: f.metodo, importe: -f.importe });
        actual.anulado = actual.anulado || anulados.has(f.id);
        for (const i of ((f.detalle as any)?.imputaciones ?? []) as { receiptId: string; aplicado: number; resta?: number }[])
          actual.imputaciones.push(i);
        comprobantes.set(clave, actual);
      }

      const saldo = acumulado;
      const pendientes = recibos.filter((r) => r.estado === 'PENDING' && r.saldo > 0);
      // Cada cargo impago cae en el tramo de su propio vencimiento.
      const antiguedad = Object.fromEntries(TRAMOS.map((t) => [t, 0])) as Record<Tramo, number>;
      for (const r of pendientes) antiguedad[tramoDe(r.vencimiento, hoyStr)] += r.saldo;

      // El primer mes (desde el actual) que todavía no tiene su abono: desde ahí rige un cambio
      // de importe de las cocheras.
      let proximoAbono = hoyStr.slice(0, 7);
      while (recibosDb.some((r) => r.periodo === proximoAbono))
        proximoAbono = dayjs(`${proximoAbono}-01`).add(1, 'month').format('YYYY-MM');

      const baja = !!c.deletedAt;
      // Un dado de baja conserva a la vista las cocheras que tenía; uno activo, solo las vigentes.
      const cocheras = (c.parkingRenters ?? []).filter((r) => baja || !r.deletedAt);

      return {
        cliente: {
          id: c.id,
          nombre: c.firstName,
          apellido: c.lastName,
          telefono: c.phone ?? null,
          comentarios: c.comments ?? null,
          alta: c.createdAt,
          baja: c.deletedAt ?? null,
          abono: baja ? 0 : cocheras.reduce((s, r) => s + (r.amount ?? 0), 0),
          cocheras: cocheras.map((r) => ({
            numero: r.garageNumber ?? null,
            duenio: r.parkingOwner?.customer
              ? `${r.parkingOwner.customer.lastName} ${r.parkingOwner.customer.firstName}`.trim()
              : r.owner || null,
            importe: r.amount ?? 0,
          })),
        },
        saldo,
        vencido: Math.min(Math.max(0, saldo), pendientes.filter((r) => r.vencido).reduce((s, r) => s + r.saldo, 0)),
        antiguedad,
        proximoAbono,
        tieneSaldoInicial: filas.some((f) => f.tipo === 'SALDO_INICIAL' && !anulados.has(f.id) && !(f.detalle as any)?.migrado),
        recibos,
        movimientos: movimientos.reverse(),
        comprobantes: [...comprobantes.values()]
          .map((x) => ({ ...x, imputaciones: agruparPorRecibo(x.imputaciones) }))
          .sort((a, b) => b.fecha.localeCompare(a.fecha)),
      };
    });
  }

  // ------------------------------------------------------------------ cobro

  // A un dado de baja también se le cobra: dejar de alquilar no cancela lo que debe.
  // `dto` puede traer MERCADOPAGO solo cuando llama la acreditación de un cobro con QR: el
  // controlador valida el pedido del mostrador contra los medios manuales. `tolerante`: la
  // acreditación no puede fallar porque un cargo elegido al generar el QR ya se pagó por otro
  // lado (la plata ya entró): esos se ignoran y se aplica del más viejo al más nuevo.
  async registrarPago(
    customerId: string,
    dto: Omit<RegistrarPagoDto, 'pagos' | 'solicitudId'> & {
      pagos: { metodo: CuentaMetodo; importe: number }[];
      solicitudId?: string;
    },
    usuarioId: string | null,
    tolerante = false,
  ) {
    const playaId = await this.asegurarModulo();
    return this.ds.transaction(async (m) => {
      const c = await this.inquilino(m, customerId);
      await asegurarCuenta(m, customerId);
      await bloquearCliente(m, customerId);

      // Reintento de un cobro ya registrado (se perdió la respuesta): se devuelve el mismo recibo.
      // El bloqueo del cliente ordena los pedidos, así el segundo ya ve lo que guardó el primero.
      if (dto.solicitudId) {
        const previas = await m.find(CuentaMovimiento, { where: { solicitud: dto.solicitudId, tipo: 'PAGO' } });
        if (previas.length) {
          if (previas.some((f) => f.customerId !== customerId))
            throw new ConflictException('Ese pedido de cobro corresponde a otro inquilino.');
          return { ...(await this.reciboDePago(m, previas, c)), repetido: true };
        }
      }

      const pagos = dto.pagos.filter((p) => p.importe > 0);
      const total = pagos.reduce((s, p) => s + p.importe, 0);
      if (!total) throw new BadRequestException('Ingresá el importe cobrado.');
      if (new Set(pagos.map((p) => p.metodo)).size !== pagos.length)
        throw new BadRequestException('Cada medio de pago va una sola vez.');
      const saldoAnterior = await saldoDe(m, customerId);

      // Orden de imputación: primero los recibos elegidos, después el resto del más viejo al
      // más nuevo. Lo que sobra queda como saldo a favor.
      const pendientes = await m.find(Receipt, {
        ...cargosDe(customerId, { status: 'PENDING' }),
        order: { startDate: 'ASC', createdAt: 'ASC' },
      });
      const elegidos = [...new Set(dto.receiptIds ?? [])].filter((id) => !tolerante || pendientes.some((r) => r.id === id));
      for (const id of elegidos)
        if (!pendientes.some((r) => r.id === id))
          throw new BadRequestException('Alguno de los cargos elegidos ya no está pendiente.');
      const orden = [
        ...elegidos.map((id) => pendientes.find((r) => r.id === id)!),
        ...pendientes.filter((r) => !elegidos.includes(r.id)),
      ];

      // Numeración de comprobantes por playa, sin saltos ni repetidos entre cajas simultáneas.
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pagos-inquilinos:${playaId}`]);
      const [ultimo] = await m.query(
        `SELECT numero FROM cuenta_movimientos WHERE tipo = 'PAGO' AND numero IS NOT NULL ORDER BY sequence DESC LIMIT 1`,
      );
      const numero = String((parseInt(ultimo?.numero ?? '0', 10) || 0) + 1).padStart(8, '0');
      const fecha = hoy();

      // El efectivo entra a la caja del día (y al turno abierto) en la misma transacción.
      const efectivo = pagos.filter((p) => p.metodo === 'CASH').reduce((s, p) => s + p.importe, 0);
      const caja = await this.boxLists.applyTicketPayment(fecha, efectivo, m);

      // Primero se reparte todo el cobro y recién después se asienta: cada fila guarda cómo
      // quedó cada recibo y la cuenta al terminar, porque el libro no se puede editar después y
      // una reimpresión tiene que decir lo mismo que el comprobante original.
      const restante = new Map(orden.map((r) => [r.id, Math.max(0, r.price ?? 0)]));
      const reparto = pagos.map((pago) => {
        let resta = pago.importe;
        const detalle: { receiptId: string; aplicado: number }[] = [];
        for (const r of orden) {
          if (resta <= 0) break;
          const disponible = restante.get(r.id) ?? 0;
          if (disponible <= 0) continue;
          const aplicado = Math.min(disponible, resta);
          detalle.push({ receiptId: r.id, aplicado });
          restante.set(r.id, disponible - aplicado);
          resta -= aplicado;
        }
        return { pago, detalle, aFavor: resta };
      });
      const saldoDespues = saldoAnterior - total;
      // El turno de la caja compartida en que se cobra: el pago solo se puede anular mientras
      // siga abierto (ver anulacion.ts). Sin turnos en uso queda null y rige el día.
      const [turno] = await m.query(`SELECT id FROM turnos WHERE estado = 'ABIERTO' AND "cashVersion" = 2 LIMIT 1`);

      const mediosDe = new Map<string, Set<string>>();
      const filas: CuentaMovimiento[] = [];
      for (const { pago, detalle, aFavor: sobra } of reparto) {
        const fila = await asentar(m, {
          customerId,
          tipo: 'PAGO',
          importe: -pago.importe,
          fecha,
          concepto: `Pago N° ${numero}`,
          metodo: pago.metodo,
          numero,
          motivo: dto.nota?.trim() || null,
          usuarioId,
          solicitud: dto.solicitudId ?? null,
          detalle: {
            imputaciones: detalle.map((d) => ({ ...d, resta: restante.get(d.receiptId) ?? 0 })),
            aFavor: sobra,
            saldoDespues,
            turnoId: turno?.id ?? null,
          },
        });
        filas.push(fila!);
        for (const d of detalle) {
          await m.save(
            m.create(ReceiptPayment, {
              paymentType: pago.metodo,
              price: d.aplicado,
              paymentDate: fecha,
              receipt: { id: d.receiptId } as Receipt,
              boxList: { id: caja.id } as any,
              numberInBox: d.aplicado,
              cuentaMovimientoId: fila!.id,
            }),
          );
          mediosDe.set(d.receiptId, (mediosDe.get(d.receiptId) ?? new Set()).add(pago.metodo));
        }
      }

      for (const r of orden) {
        const nuevo = restante.get(r.id) ?? 0;
        if (nuevo === Math.max(0, r.price ?? 0)) continue;
        const medios = [...(mediosDe.get(r.id) ?? [])];
        await m.update(Receipt, { id: r.id }, {
          price: nuevo,
          ...(nuevo <= 0
            ? { status: 'PAID' as const, paymentDate: fecha, paymentType: (medios.length === 1 ? medios[0] : 'MIX') as any }
            : {}),
        });
      }

      await conciliar(m, customerId);
      return { ...(await this.reciboDePago(m, filas, c)), repetido: false };
    });
  }

  // El recibo de un pago, armado solo con lo que quedó asentado: el cobro recién hecho, su
  // reintento y una reimpresión dicen exactamente lo mismo. Una línea por cargo aunque lo hayan
  // cubierto dos medios: dice cuánto se aplicó a cada uno y cuánto le quedó.
  private async reciboDePago(m: EntityManager, filas: CuentaMovimiento[], c: Customer) {
    const detalles = filas.map(
      (f) =>
        (f.detalle ?? {}) as {
          imputaciones?: { receiptId: string; aplicado: number; resta?: number }[];
          aFavor?: number;
          saldoDespues?: number;
        },
    );
    const lineas = agruparPorRecibo(detalles.flatMap((d) => d.imputaciones ?? []));
    const cargos = lineas.length ? await m.find(Receipt, { where: { id: In(lineas.map((l) => l.receiptId)) }, withDeleted: true }) : [];
    const total = filas.reduce((s, f) => s - f.importe, 0);
    const saldo = detalles[0]?.saldoDespues ?? (await saldoDe(m, c.id));
    return {
      // El asiento que representa al pago (el primero): con él se emite y se encuentra su recibo.
      id: [...filas].sort((a, b) => Number(a.sequence) - Number(b.sequence))[0].id,
      numero: filas[0].numero,
      fecha: String(filas[0].fecha).slice(0, 10),
      cliente: `${c.lastName} ${c.firstName}`.trim(),
      total,
      medios: filas.map((f) => ({ metodo: f.metodo, importe: -f.importe })),
      imputaciones: lineas.map((l) => {
        const cargo = cargos.find((r) => r.id === l.receiptId);
        return {
          receiptId: l.receiptId,
          concepto: cargo ? conceptoDeRecibo(cargo) : 'Cargo',
          aplicado: l.aplicado,
          saldoRecibo: l.resta ?? cargo?.price ?? 0,
        };
      }),
      aFavor: detalles.reduce((s, d) => s + (d.aFavor ?? 0), 0),
      saldoAnterior: saldo + total,
      saldo,
      nota: filas[0].motivo,
    };
  }

  // ------------------------------------------------------------------ cobro con QR (MercadoPago)

  // Antes de generar el QR: que la sección esté prendida, que el cliente sea un inquilino de esta
  // playa y cómo se llama (va en la descripción que ve al pagar).
  async validarCobroQr(customerId: string) {
    await this.asegurarModulo();
    return this.ds.transaction(async (m) => {
      const c = await this.inquilino(m, customerId);
      return { nombre: `${c.lastName ?? ''} ${c.firstName ?? ''}`.trim() || 'Inquilino' };
    });
  }

  // La acreditación de un cobro con QR: un pago más de la cuenta, con MercadoPago como medio. El
  // id del cobro va como solicitud: si la consulta se repite, el pago no se asienta dos veces.
  async registrarPagoMercadoPago(
    customerId: string,
    datos: { importe: number; receiptIds?: string[]; nota?: string | null; cobroId: string },
    usuarioId: string | null,
  ) {
    return this.registrarPago(
      customerId,
      {
        pagos: [{ metodo: 'MERCADOPAGO', importe: datos.importe }],
        receiptIds: datos.receiptIds,
        nota: datos.nota ?? undefined,
        solicitudId: datos.cobroId,
      },
      usuarioId,
      true,
    );
  }

  // El recibo del pago que asentó un cobro con QR, para mostrarlo en el mostrador al acreditarse.
  async reciboDeCobro(cobroId: string) {
    return this.ds.transaction(async (m) => {
      const filas = await m.find(CuentaMovimiento, { where: { solicitud: cobroId, tipo: 'PAGO' } });
      if (!filas.length) return null;
      return this.reciboDePago(m, filas, await this.inquilino(m, filas[0].customerId));
    });
  }

  // ------------------------------------------------------------------ recibo entregable

  // El recibo de un pago como comprobante público, por el mismo circuito que los tickets: una
  // foto congelada con un enlace secreto, que se entrega por QR, WhatsApp o impresora según lo que
  // tenga prendido la playa. Pedirlo de nuevo devuelve el mismo enlace.
  async emitirComprobante(pagoId: string) {
    const playaId = await this.asegurarModulo();
    return this.ds.transaction(async (m) => {
      const [config] = await m.query('SELECT "receiptDelivery" FROM ticket_schedule_settings LIMIT 1');
      const settings = { whatsapp: false, qr: false, print: false, paperWidth: 80, ...(config?.receiptDelivery ?? {}) };

      const pago = await m.findOne(CuentaMovimiento, { where: { id: pagoId, tipo: 'PAGO' } });
      if (!pago) throw new NotFoundException('Pago no encontrado.');
      if (await yaAnulado(m, pago.id)) throw new BadRequestException('Ese pago está anulado: no tiene recibo para entregar.');
      const c = await this.inquilino(m, pago.customerId);
      // A diferencia de un ticket, el inquilino es un contacto conocido: con un celular cargado el
      // recibo siempre se puede mandar por WhatsApp, esté o no prendido ese medio para los tickets.
      // QR y térmica sí siguen la configuración de la playa.
      const telefono = telefonoParaWhatsapp(c.phone);
      if (!telefono && !settings.qr && !settings.print) return { deshabilitado: true as const, settings };

      const filas = pago.numero
        ? await m.find(CuentaMovimiento, { where: { customerId: pago.customerId, tipo: 'PAGO', numero: pago.numero } })
        : [pago];
      const recibo = await this.reciboDePago(m, filas, c);

      // Dos pedidos juntos por el mismo pago tienen que terminar en el mismo enlace.
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`recibo-pago:${recibo.id}`]);
      const repo = m.getRepository(ParkingReceipt);
      let comprobante = await repo.findOneBy({ playaId, registrationId: recibo.id, kind: 'PAGO' });
      if (!comprobante) {
        const playa = await m.getRepository(Playa).findOneByOrFail({ id: playaId });
        const snapshot: ReciboPagoSnapshot = {
          kind: 'PAGO',
          parkingName: playa.nombre,
          address: playa.direccion ?? null,
          numero: recibo.numero ?? '—',
          fecha: recibo.fecha,
          cliente: recibo.cliente,
          total: recibo.total,
          medios: recibo.medios.map((x) => ({ medio: nombreDeMedio(x.metodo), importe: x.importe })),
          aplicado: recibo.imputaciones.map((i) => ({ concepto: i.concepto, importe: i.aplicado, queda: i.saldoRecibo })),
          aFavor: recibo.aFavor,
          saldo: recibo.saldo,
        };
        comprobante = await repo.save(
          repo.create({ playaId, registrationId: recibo.id, kind: 'PAGO', token: randomBytes(32).toString('hex'), snapshot }),
        );
      }
      return {
        deshabilitado: false as const,
        token: comprobante.token,
        snapshot: comprobante.snapshot as ReciboPagoSnapshot,
        settings,
        telefono,
      };
    });
  }

  // ------------------------------------------------------------------ saldo inicial

  // `manager` viene del alta del inquilino, que ya está en su propia transacción.
  async registrarSaldoInicial(
    customerId: string,
    dto: SaldoInicialDto,
    usuarioId: string | null,
    manager?: EntityManager,
  ) {
    if (!manager) await this.asegurarModulo();
    const correr = async (m: EntityManager) => {
      await this.inquilino(m, customerId);
      await asegurarCuenta(m, customerId);
      await bloquearCliente(m, customerId);
      if (dto.tipo === 'AL_DIA') return { saldo: await saldoDe(m, customerId) };

      const previos = await m.find(CuentaMovimiento, { where: { customerId, tipo: 'SALDO_INICIAL' } });
      for (const p of previos)
        if (!(p.detalle as any)?.migrado && !(await yaAnulado(m, p.id)))
          throw new ConflictException({
            code: 'SALDO_INICIAL_EXISTENTE',
            message: 'Este inquilino ya tiene un saldo inicial. Anulalo o cargá un ajuste.',
          });

      const nota = dto.nota?.trim() || null;
      const hoyStr = hoy();

      if (dto.tipo === 'A_FAVOR') {
        if (!dto.importe) throw new BadRequestException('Ingresá el saldo a favor.');
        await asentar(m, {
          customerId,
          tipo: 'SALDO_INICIAL',
          importe: -dto.importe,
          fecha: dto.fecha ?? hoyStr,
          concepto: 'Saldo inicial a favor',
          motivo: nota,
          usuarioId,
        });
        return { saldo: await conciliar(m, customerId) };
      }

      if (dto.modo === 'POR_MES') {
        const meses = dto.meses ?? [];
        if (!meses.length) throw new BadRequestException('Agregá al menos un mes adeudado.');
        if (new Set(meses.map((x) => x.mes)).size !== meses.length)
          throw new BadRequestException('Hay meses repetidos.');
        if (meses.some((x) => x.mes > hoyStr.slice(0, 7)))
          throw new BadRequestException('No se puede cargar deuda de meses que todavía no empezaron.');
        // Cada mes adeudado es el cargo de ese período: no puede haber otro cargo del mismo mes.
        const existentes = await m.find(Receipt, cargosDe(customerId));
        const ocupados = meses.filter((x) => existentes.some((r) => r.periodo === x.mes));
        if (ocupados.length)
          throw new ConflictException({
            code: 'MES_CON_CARGO',
            message: `Ya hay un cargo de ${ocupados.map((x) => mesLargo(x.mes)).join(', ')}.`,
          });
        for (const x of [...meses].sort((a, b) => a.mes.localeCompare(b.mes)))
          await this.receipts.createReceipt(customerId, m, x.importe, `${x.mes}-02`, null, {
            origen: 'SALDO_INICIAL',
            tipoCargo: 'SALDO_INICIAL',
            periodo: x.mes,
            concepto: `Deuda de ${mesLargo(x.mes)}`,
            motivo: nota,
            usuarioId,
          });
        return { saldo: await saldoDe(m, customerId) };
      }

      if (!dto.importe) throw new BadRequestException('Ingresá el importe adeudado.');
      const fecha = dto.fecha ?? hoyStr;
      if (fecha > hoyStr) throw new BadRequestException('La fecha de corte no puede ser futura.');
      // Lo que se debía a esa fecha ya estaba para pagar: vence ese mismo día.
      await this.receipts.createReceipt(customerId, m, dto.importe, fecha, null, {
        origen: 'SALDO_INICIAL',
        tipoCargo: 'SALDO_INICIAL',
        periodo: null,
        vencimiento: fecha,
        concepto: `Saldo inicial al ${fechaAR(fecha)}`,
        motivo: nota,
        usuarioId,
      });
      return { saldo: await saldoDe(m, customerId) };
    };
    return manager ? correr(manager) : this.ds.transaction(correr);
  }

  // ------------------------------------------------------------------ ajustes

  async registrarAjuste(customerId: string, dto: AjusteDto, usuarioId: string) {
    await this.asegurarModulo();
    return this.ds.transaction(async (m) => {
      const c = await this.inquilino(m, customerId);
      await asegurarCuenta(m, customerId);
      await bloquearCliente(m, customerId);
      const motivo = dto.motivo.trim();
      const fecha = hoy();

      if (dto.tipo === 'RECARGO') {
        // El recargo es un cargo propio (sin período): se ve pendiente y se cobra como cualquier otro.
        await this.receipts.createReceipt(customerId, m, dto.importe, fecha, null, {
          origen: 'AJUSTE',
          concepto: `Recargo: ${motivo}`.slice(0, 160),
          motivo,
          usuarioId,
        });
        return { saldo: await saldoDe(m, customerId) };
      }

      // Bonificación: baja la deuda. Se imputa primero al cargo indicado y después del más
      // viejo al más nuevo; lo que no alcance a imputarse queda a favor.
      const pendientes = await m.find(Receipt, {
        ...cargosDe(c.id, { status: 'PENDING' }),
        order: { startDate: 'ASC', createdAt: 'ASC' },
      });
      if (dto.receiptId && !pendientes.some((r) => r.id === dto.receiptId))
        throw new BadRequestException('El cargo elegido ya no está pendiente.');
      const orden = dto.receiptId
        ? [pendientes.find((r) => r.id === dto.receiptId)!, ...pendientes.filter((r) => r.id !== dto.receiptId)]
        : pendientes;
      const fila = await asentar(m, {
        customerId,
        tipo: 'AJUSTE',
        importe: -dto.importe,
        fecha,
        concepto: `Bonificación: ${motivo}`.slice(0, 160),
        receiptId: dto.receiptId ?? null,
        motivo,
        usuarioId,
      });
      let resta = dto.importe;
      for (const r of orden) {
        if (resta <= 0) break;
        const aplicado = Math.min(Math.max(0, r.price ?? 0), resta);
        if (!aplicado) continue;
        await m.save(
          m.create(ReceiptPayment, {
            paymentType: 'FIX',
            price: aplicado,
            paymentDate: fecha,
            receipt: { id: r.id } as Receipt,
            numberInBox: null,
            cuentaMovimientoId: fila!.id,
          }),
        );
        const nuevo = (r.price ?? 0) - aplicado;
        await m.update(Receipt, { id: r.id }, {
          price: nuevo,
          ...(nuevo <= 0 ? { status: 'PAID' as const, paymentDate: fecha, paymentType: 'FIX' as any } : {}),
        });
        resta -= aplicado;
      }
      return { saldo: await conciliar(m, customerId) };
    });
  }

  // ------------------------------------------------------------------ anulación

  // Anular nunca borra el asiento: agrega uno igual y de signo contrario. Un pago con varios
  // medios se anula entero, porque es un solo comprobante. Qué se puede anular y hasta cuándo
  // lo decide reglaAnulacion; además hay que dar el motivo y escribir el importe, para que
  // nadie anule plata por un clic de más.
  async anular(movimientoId: string, dto: { motivo: string; confirmacion: number }, usuarioId: string) {
    await this.asegurarModulo();
    return this.ds.transaction(async (m) => {
      const fila = await m.findOne(CuentaMovimiento, { where: { id: movimientoId } });
      if (!fila) throw new NotFoundException('Movimiento no encontrado.');
      await this.inquilino(m, fila.customerId);
      await bloquearCliente(m, fila.customerId);

      const todas = await m.find(CuentaMovimiento, { where: { customerId: fila.customerId } });
      const regla = reglaAnulacion(fila, await contextoAnulacion(m, fila.customerId, todas));
      if ('code' in regla) throw new ConflictException({ code: regla.code, message: regla.motivo });

      const filas =
        fila.tipo === 'PAGO' && fila.numero
          ? todas.filter((f) => f.tipo === 'PAGO' && f.numero === fila.numero)
          : [fila];
      for (const f of filas)
        if (await yaAnulado(m, f.id)) throw new ConflictException({ code: 'YA_ANULADO', message: 'Ya estaba anulado.' });

      const nota = dto.motivo.trim();
      if (nota.length < 10)
        throw new BadRequestException({
          code: 'MOTIVO_CORTO',
          message: 'Contá el motivo con un poco más de detalle (al menos 10 caracteres).',
        });
      const importe = Math.abs(filas.reduce((s, f) => s + f.importe, 0));
      if (dto.confirmacion !== importe)
        throw new BadRequestException({
          code: 'CONFIRMACION_INCORRECTA',
          message: `Para confirmar, escribí el importe exacto: ${plataTexto(importe)}.`,
        });

      const fecha = hoy();

      if ((fila.detalle as any)?.cambioAbono && fila.receiptId) {
        // Cambio de abono: el recibo del mes vuelve al importe anterior, suba o baje.
        const recibo = await m.findOne(Receipt, { where: { id: fila.receiptId } });
        if (recibo) {
          const saldoRecibo = Math.max(0, (recibo.price ?? 0) - fila.importe);
          await m.update(Receipt, { id: recibo.id }, {
            price: saldoRecibo,
            startAmount: Math.max(0, (recibo.startAmount ?? 0) - fila.importe),
            ...(saldoRecibo === 0
              ? { status: 'PAID' as const, paymentDate: fecha }
              : { status: 'PENDING' as const, paymentDate: null }),
          });
        }
      } else if (fila.tipo === 'PAGO') {
        for (const f of filas) await deshacerImputaciones(m, f.id);
        // El efectivo que se devuelve sale hoy de la caja.
        const efectivo = filas.filter((f) => f.metodo === 'CASH').reduce((s, f) => s - f.importe, 0);
        if (efectivo) await this.boxLists.applyTicketPayment(fecha, -efectivo, m);
      } else if (fila.tipo === 'DEVOLUCION') {
        // La devolución no ocurrió: si el efectivo había salido de la caja, vuelve a entrar.
        const efectivo = filas.filter((f) => f.metodo === 'CASH').reduce((s, f) => s + f.importe, 0);
        if (efectivo) await this.boxLists.applyTicketPayment(fecha, efectivo, m);
      } else if (fila.importe > 0 && fila.receiptId) {
        const recibo = await m.findOne(Receipt, { where: { id: fila.receiptId } });
        const origen = await m.findOne(CuentaMovimiento, {
          where: { receiptId: fila.receiptId },
          order: { sequence: 'ASC' },
        });
        if (recibo && origen?.id === fila.id) {
          // Cargo, deuda inicial o recargo: el asiento creó el recibo, así que se van juntos.
          if (await pagosRealesDe(m, recibo.id))
            throw new BadRequestException('El recibo tiene pagos. Anulá primero esos pagos.');
          await m.remove(Receipt, recibo);
        }
      } else if (fila.importe < 0) {
        // Bonificación o saldo a favor: se devuelven sus imputaciones a los recibos.
        await deshacerImputaciones(m, fila.id);
      }

      for (const f of filas)
        await asentar(m, {
          customerId: f.customerId,
          tipo: 'ANULACION',
          importe: -f.importe,
          fecha,
          concepto: `Anulación: ${f.concepto}`,
          metodo: f.metodo,
          anulaId: f.id,
          numero: f.numero,
          motivo: nota,
          usuarioId,
        });
      return { saldo: await conciliar(m, fila.customerId) };
    });
  }

  // Las anulaciones de la playa en un mes: quién anuló qué, cuándo y por qué. Es donde el dueño
  // controla, ya que en la cuenta de cada inquilino quedan ocultas.
  async anulaciones(mes: string) {
    await this.asegurarModulo();
    return this.ds.transaction(async (m) => {
      const filas: any[] = await m.query(
        `SELECT a.id, a."customerId", a.numero, a.motivo, a."createdAt", a.importe,
                o.tipo AS "tipoOriginal", o.concepto AS "conceptoOriginal", to_char(o.fecha, 'YYYY-MM-DD') AS "fechaOriginal", o.metodo,
                c."firstName", c."lastName", u."firstName" AS "usuarioNombre", u."lastName" AS "usuarioApellido"
         FROM cuenta_movimientos a
         JOIN cuenta_movimientos o ON o.id = a."anulaId"
         JOIN customers c ON c.id = a."customerId"
         LEFT JOIN users u ON u.id = a."usuarioId"
         WHERE a.tipo = 'ANULACION'
           AND to_char(a."createdAt" AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM') = $1
         ORDER BY a.sequence DESC`,
        [mes],
      );

      // Un pago con varios medios se anuló de una vez: va como una sola línea.
      const lineas = new Map<string, any>();
      for (const f of filas) {
        const clave = f.tipoOriginal === 'PAGO' && f.numero ? `${f.customerId}:${f.numero}` : f.id;
        const actual = lineas.get(clave) ?? {
          id: f.id,
          creado: f.createdAt,
          inquilino: { id: f.customerId, nombre: `${f.lastName ?? ''} ${f.firstName ?? ''}`.trim() },
          tipo: f.tipoOriginal,
          concepto: f.tipoOriginal === 'PAGO' && f.numero ? `Pago N° ${f.numero}` : f.conceptoOriginal,
          fechaOriginal: f.fechaOriginal,
          medios: [] as string[],
          // Lo que cambió la cuenta: negativo si bajó la deuda, positivo si volvió deuda.
          efecto: 0,
          motivo: f.motivo,
          usuario: `${f.usuarioNombre ?? ''} ${f.usuarioApellido ?? ''}`.trim() || null,
        };
        actual.efecto += Number(f.importe);
        if (f.metodo) actual.medios.push(f.metodo);
        lineas.set(clave, actual);
      }
      const lista = [...lineas.values()];
      return {
        mes,
        lista,
        totales: {
          cantidad: lista.length,
          deudaAnulada: lista.filter((l) => l.tipo !== 'PAGO' && l.efecto < 0).reduce((s, l) => s - l.efecto, 0),
          pagosAnulados: lista.filter((l) => l.tipo === 'PAGO').reduce((s, l) => s + l.efecto, 0),
        },
      };
    });
  }

  // ------------------------------------------------------------------ devolución

  // Plata que efectivamente se le devuelve al inquilino. No es anular: el pago existió y queda;
  // lo que se registra es la salida de la caja o del banco. Solo se devuelve saldo a favor: si el
  // pago cubrió cargos que no correspondían, primero se corrigen esos cargos.
  async registrarDevolucion(customerId: string, dto: DevolucionDto, usuarioId: string) {
    await this.asegurarModulo();
    return this.ds.transaction(async (m) => {
      await this.inquilino(m, customerId);
      await asegurarCuenta(m, customerId);
      await bloquearCliente(m, customerId);
      if (dto.solicitudId) {
        const previa = await m.findOne(CuentaMovimiento, { where: { solicitud: dto.solicitudId, tipo: 'DEVOLUCION' } });
        if (previa) return { saldo: await saldoDe(m, customerId), repetido: true };
      }

      const aFavor = -(await saldoDe(m, customerId));
      if (dto.importe > aFavor)
        throw new BadRequestException({
          code: 'DEVOLUCION_SIN_SALDO_A_FAVOR',
          message:
            aFavor > 0
              ? `Solo tiene ${plataTexto(aFavor)} a favor para devolver.`
              : 'No tiene saldo a favor. Si un cargo no correspondía, corregilo primero (bonificación o anulación).',
        });

      const fecha = hoy();
      if (dto.metodo === 'CASH') await this.boxLists.applyTicketPayment(fecha, -dto.importe, m);
      const [turno] = await m.query(`SELECT id FROM turnos WHERE estado = 'ABIERTO' AND "cashVersion" = 2 LIMIT 1`);
      await asentar(m, {
        customerId,
        tipo: 'DEVOLUCION',
        importe: dto.importe,
        fecha,
        concepto: 'Devolución de saldo a favor',
        metodo: dto.metodo,
        motivo: dto.motivo.trim(),
        usuarioId,
        solicitud: dto.solicitudId ?? null,
        detalle: { turnoId: turno?.id ?? null },
      });
      return { saldo: await conciliar(m, customerId), repetido: false };
    });
  }

  // ------------------------------------------------------------------ abonos del mes

  // Cargar los abonos de un mes registra cuánto corresponde cobrarle a cada inquilino (el recibo
  // se emite recién cuando paga). Antes de confirmar se muestra exactamente qué se va a cargar,
  // qué ya estaba y qué no se puede cargar y por qué.
  async previsualizarAbonos(mes: string) {
    await this.asegurarModulo();
    validarMesDeAbono(mes);
    return this.ds.transaction(async (m) => this.planDeAbonos(m, mes, await diaDeVencimiento(m)));
  }

  private async planDeAbonos(m: EntityManager, mes: string, vencimientoDia: number) {
    // Los dados de baja quedan afuera por su borrado lógico: no se les cargan más abonos.
    const clientes = await m.find(Customer, {
      where: { customerType: 'RENTER' },
      relations: ['parkingRenters'],
      order: { lastName: 'ASC', firstName: 'ASC' },
    });
    const conCargo = new Set<string>(
      (await m.query('SELECT "customerId" FROM receipts WHERE periodo = $1 AND "deletedAt" IS NULL', [mes])).map(
        (f: any) => f.customerId,
      ),
    );
    const aCargar: { id: string; nombre: string; cocheras: string[]; importe: number }[] = [];
    const yaCargados: { id: string; nombre: string }[] = [];
    const sinCargar: { id: string; nombre: string; motivo: string }[] = [];
    for (const c of clientes) {
      const nombre = `${c.lastName} ${c.firstName}`.trim();
      const cocheras = c.parkingRenters ?? [];
      const importe = cocheras.reduce((s, r) => s + (r.amount ?? 0), 0);
      if (conCargo.has(c.id)) yaCargados.push({ id: c.id, nombre });
      else if (!cocheras.length) sinCargar.push({ id: c.id, nombre, motivo: 'No tiene cocheras asignadas.' });
      else if (!importe) sinCargar.push({ id: c.id, nombre, motivo: 'El abono de sus cocheras es de $ 0.' });
      else aCargar.push({ id: c.id, nombre, cocheras: cocheras.map((r) => r.garageNumber).filter(Boolean), importe });
    }
    return {
      mes,
      vencimientoDia,
      vencimiento: vencimientoDe(mes, vencimientoDia),
      total: aCargar.reduce((s, x) => s + x.importe, 0),
      aCargar,
      yaCargados,
      sinCargar,
    };
  }

  async cargarAbonos(mes: string, vencimientoDia: number, usuarioId: string) {
    const playaId = await this.asegurarModulo();
    validarMesDeAbono(mes);
    return this.ds.transaction(async (m) => {
      // Dos cargas simultáneas del mismo mes irían en serie: la segunda ya ve lo que cargó la
      // primera. El índice único por período es la última defensa.
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`abonos-inquilinos:${playaId}:${mes}`]);
      await m.query('UPDATE ticket_schedule_settings SET "vencimientoAbonoDia" = $1', [vencimientoDia]);
      const plan = await this.planDeAbonos(m, mes, vencimientoDia);

      const cargados: { id: string; nombre: string; importe: number }[] = [];
      const fallidos: { id: string; nombre: string; motivo: string }[] = [];
      for (const x of plan.aCargar) {
        try {
          // Cada uno en su propio punto de guardado: si uno falla, los demás se cargan igual.
          await m.transaction((sp) =>
            this.receipts.createReceipt(x.id, sp, x.importe, `${mes}-02`, null, {
              origen: 'CARGO',
              tipoCargo: 'ABONO',
              periodo: mes,
              vencimiento: plan.vencimiento,
              usuarioId,
            }),
          );
          cargados.push({ id: x.id, nombre: x.nombre, importe: x.importe });
        } catch (error: any) {
          fallidos.push({ id: x.id, nombre: x.nombre, motivo: error?.response?.message ?? 'No se pudo cargar.' });
        }
      }
      const total = cargados.reduce((s, x) => s + x.importe, 0);
      return {
        mes,
        vencimiento: plan.vencimiento,
        cargados: cargados.length,
        total,
        yaCargados: plan.yaCargados,
        sinCargar: [...plan.sinCargar, ...fallidos],
        detalle: `${cargados.length} ${cargados.length === 1 ? 'abono' : 'abonos'} de ${mesLargo(mes)} por ${plataTexto(total)}`,
      };
    });
  }
}
