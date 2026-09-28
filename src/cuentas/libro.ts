import { EntityManager, FindOptionsWhere, IsNull, Not } from 'typeorm';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { Customer } from 'src/customers/entities/customer.entity';
import { Receipt } from 'src/receipts/entities/receipt.entity';
import { ReceiptPayment } from 'src/receipts/entities/receipt-payment.entity';
import { CuentaMetodo, CuentaMovimiento, CuentaTipo } from './entities/cuenta-movimiento.entity';

dayjs.extend(utc);
dayjs.extend(timezone);

// Las operaciones básicas del libro de la cuenta corriente. Viven fuera de un servicio porque
// las usan tres módulos (recibos, clientes y cuentas) y todas corren dentro de la transacción de
// quien llama: reciben su EntityManager y nunca abren una propia.

const TZ = 'America/Argentina/Buenos_Aires';
const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export const hoy = () => dayjs().tz(TZ).format('YYYY-MM-DD');

// «2026-10-02» → «octubre 2026».
export function mesLargo(fecha: string) {
  const [anio, mes] = fecha.slice(0, 7).split('-').map(Number);
  return `${MESES[mes - 1] ?? ''} ${anio}`;
}

export const plataTexto = (n: number) => `$ ${Math.round(n).toLocaleString('es-AR')}`;

// El día del mes en que vence el abono en esta playa (se elige al cargar los abonos del mes).
export async function diaDeVencimiento(manager: EntityManager): Promise<number> {
  const [fila] = await manager.query('SELECT "vencimientoAbonoDia" AS dia FROM ticket_schedule_settings LIMIT 1');
  return Math.min(28, Math.max(1, Number(fila?.dia ?? 10)));
}

// Vencimiento del cargo de un período. Nunca antes del día en que se carga: lo que se cobra por
// primera vez hoy no puede estar vencido desde antes (un alta a fin de mes, un abono cargado tarde).
export function vencimientoDe(periodo: string, dia: number, tope = hoy()) {
  const fecha = `${periodo}-${String(dia).padStart(2, '0')}`;
  return fecha < tope ? tope : fecha;
}

export function fechaDeRecibo(r: Receipt) {
  return String(r.startDate ?? r.dateNow ?? dayjs(r.createdAt).tz(TZ).format('YYYY-MM-DD')).slice(0, 10);
}

export function conceptoDeRecibo(r: Receipt) {
  return r.concepto ?? `Abono ${mesLargo(fechaDeRecibo(r))}`;
}

// Los medios viejos que no son efectivo ni cheque (TP, MIX) se cuentan como transferencia: no
// pasaron por la caja física, que es lo que importa distinguir.
function metodoDe(tipo: string | null | undefined): CuentaMetodo {
  if (tipo === 'CASH') return 'CASH';
  if (tipo === 'CHECK') return 'CHECK';
  return 'TRANSFER';
}

type Asiento = {
  customerId: string;
  tipo: CuentaTipo;
  importe: number;
  fecha: string;
  concepto: string;
  metodo?: CuentaMetodo | null;
  receiptId?: string | null;
  anulaId?: string | null;
  numero?: string | null;
  motivo?: string | null;
  usuarioId?: string | null;
  detalle?: Record<string, unknown> | null;
  solicitud?: string | null;
};

// Los cargos de un inquilino aunque esté dado de baja. Filtrar por la relación con el cliente
// deja afuera a los que tienen borrado lógico —y a un dado de baja hay que poder cobrarle—, así
// que se pide `withDeleted` y se excluyen a mano solo los cargos borrados.
export const cargosDe = (customerId: string, extra: FindOptionsWhere<Receipt> = {}) => ({
  where: { customer: { id: customerId }, deletedAt: IsNull(), ...extra },
  withDeleted: true,
});

export async function asentar(manager: EntityManager, a: Asiento): Promise<CuentaMovimiento | null> {
  const importe = Math.round(a.importe);
  if (!importe) return null;
  const repo = manager.getRepository(CuentaMovimiento);
  return repo.save(
    repo.create({
      ...a,
      importe,
      concepto: a.concepto.slice(0, 160),
      motivo: a.motivo?.slice(0, 255) ?? null,
    }),
  );
}

export async function saldoDe(manager: EntityManager, customerId: string): Promise<number> {
  const [fila] = await manager.query(
    'SELECT COALESCE(SUM(importe), 0)::bigint AS saldo FROM cuenta_movimientos WHERE "customerId" = $1',
    [customerId],
  );
  return Number(fila?.saldo ?? 0);
}

export async function bloquearCliente(manager: EntityManager, customerId: string) {
  await manager.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [customerId]);
}

// La primera vez que se toca la cuenta de un inquilino que ya existía, se arma su libro con lo
// que hay: un cargo por cada recibo, un pago por cada pago y el saldo a favor que tenía. El
// resultado cuadra con los recibos: el saldo queda igual a lo pendiente menos el crédito.
//
// Tiene que correr antes de cualquier otro asiento del cliente: si se escribiera un cargo nuevo
// primero, la cuenta dejaría de estar vacía y la historia vieja no se volcaría nunca.
export async function asegurarCuenta(manager: EntityManager, customerId: string): Promise<boolean> {
  const customer = await manager.findOne(Customer, { where: { id: customerId }, withDeleted: true });
  if (!customer || customer.customerType !== 'RENTER') return false;
  const contar = async () =>
    Number(
      (await manager.query('SELECT COUNT(*)::int AS n FROM cuenta_movimientos WHERE "customerId" = $1', [customerId]))[0]?.n ?? 0,
    );
  if ((await contar()) > 0) return true;
  // Dos pedidos simultáneos sobre una cuenta vacía volcarían la historia dos veces.
  await bloquearCliente(manager, customerId);
  if ((await contar()) > 0) return true;

  const recibos = await manager.find(Receipt, {
    ...cargosDe(customerId),
    relations: ['payments', 'paymentHistoryOnAccount'],
    order: { startDate: 'ASC', createdAt: 'ASC' },
  });

  let creditoImputado = 0;
  let primeraFecha = dayjs(customer.createdAt).tz(TZ).format('YYYY-MM-DD');
  for (const r of recibos) {
    const pagos = r.payments ?? [];
    const historial = r.paymentHistoryOnAccount ?? [];
    const pagado = [...pagos, ...historial].reduce((s, p) => s + (p.price ?? 0), 0);
    // El total se reconstruye de lo que queda más lo pagado, no de `startAmount`: el alta vieja
    // lo pisaba al cambiar el importe de la cochera y dejaba de coincidir con el saldo real.
    const total = (r.price ?? 0) + pagado;
    const fecha = fechaDeRecibo(r);
    if (fecha < primeraFecha) primeraFecha = fecha;
    await asentar(manager, {
      customerId,
      tipo: 'CARGO',
      importe: total,
      fecha,
      concepto: `${conceptoDeRecibo(r)}${r.receiptNumber ? ` · ${r.receiptNumber}` : ''}`,
      receiptId: r.id,
      detalle: { migrado: true },
    });
    for (const p of [...pagos, ...historial]) {
      const importe = p.price ?? 0;
      if (!importe) continue;
      // Pagar con crédito no es plata nueva: consume un saldo a favor que se asienta abajo.
      if (p.paymentType === 'CREDIT') {
        creditoImputado += importe;
        continue;
      }
      const esCorreccion = p.paymentType === 'FIX';
      const fila = await asentar(manager, {
        customerId,
        tipo: esCorreccion ? 'AJUSTE' : 'PAGO',
        importe: -importe,
        fecha: String(p.paymentDate ?? fecha).slice(0, 10),
        concepto: esCorreccion ? 'Corrección anterior a la cuenta corriente' : `Pago de ${conceptoDeRecibo(r).toLowerCase()}`,
        metodo: esCorreccion ? null : metodoDe(p.paymentType),
        motivo: esCorreccion ? 'Registrada antes de la cuenta corriente' : null,
        detalle: { migrado: true },
      });
      if (fila && p instanceof ReceiptPayment)
        await manager.update(ReceiptPayment, { id: p.id }, { cuentaMovimientoId: fila.id });
    }
  }

  const aFavor = (customer.credit ?? 0) + creditoImputado;
  if (aFavor > 0)
    await asentar(manager, {
      customerId,
      tipo: 'SALDO_INICIAL',
      importe: -aFavor,
      fecha: primeraFecha,
      concepto: 'Saldo a favor anterior a la cuenta corriente',
      detalle: { migrado: true },
    });
  return true;
}

// Deja los recibos de acuerdo con el libro. Lo pendiente en los recibos tiene que ser igual al
// saldo cuando el inquilino debe, y cero cuando tiene saldo a favor:
//   · si los recibos muestran más deuda que el libro, hay crédito sin usar: se imputa a los
//     recibos más viejos (pago de tipo CREDIT, que no pasa por caja);
//   · si muestran menos (se anuló un pago cuyo sobrante ya se había usado), se deshacen las
//     imputaciones de crédito más recientes hasta que vuelva a cuadrar.
// Al final deja `credit` y `hasDebt` del cliente iguales al libro, para las pantallas viejas.
export async function conciliar(manager: EntityManager, customerId: string) {
  const saldo = await saldoDe(manager, customerId);
  const pendientes = await manager.find(Receipt, {
    ...cargosDe(customerId, { status: 'PENDING' }),
    order: { startDate: 'ASC', createdAt: 'ASC' },
  });
  const pendiente = pendientes.reduce((s, r) => s + Math.max(0, r.price ?? 0), 0);
  const fecha = hoy();
  let libre = pendiente - Math.max(0, saldo);

  if (libre > 0) {
    for (const r of pendientes) {
      if (libre <= 0) break;
      const aplicar = Math.min(Math.max(0, r.price ?? 0), libre);
      if (!aplicar) continue;
      await manager.save(
        manager.create(ReceiptPayment, {
          paymentType: 'CREDIT',
          price: aplicar,
          paymentDate: fecha,
          receipt: { id: r.id } as Receipt,
          numberInBox: null,
          cuentaMovimientoId: null,
        }),
      );
      const resta = (r.price ?? 0) - aplicar;
      await manager.update(Receipt, { id: r.id }, {
        price: resta,
        ...(resta <= 0 ? { status: 'PAID' as const, paymentDate: fecha } : {}),
      });
      libre -= aplicar;
    }
  } else if (libre < 0) {
    let falta = -libre;
    const creditos = await manager.find(ReceiptPayment, {
      where: { receipt: { customer: { id: customerId }, deletedAt: IsNull() }, paymentType: 'CREDIT' },
      relations: ['receipt'],
      order: { createdAt: 'DESC' },
      withDeleted: true,
    });
    for (const p of creditos) {
      if (falta <= 0) break;
      const quitar = Math.min(p.price ?? 0, falta);
      if (!quitar) continue;
      if (quitar >= (p.price ?? 0)) await manager.delete(ReceiptPayment, { id: p.id });
      else await manager.update(ReceiptPayment, { id: p.id }, { price: (p.price ?? 0) - quitar });
      await manager.update(Receipt, { id: p.receipt.id }, {
        price: (p.receipt.price ?? 0) + quitar,
        status: 'PENDING',
        paymentDate: null,
      });
      falta -= quitar;
    }
  }

  await manager.update(Customer, { id: customerId }, {
    credit: Math.max(0, -saldo),
    hasDebt: saldo > 0,
  });
  return saldo;
}

// Deshace las imputaciones que salieron de un asiento (los pagos parciales de un cobro o una
// bonificación), devolviendo a cada recibo lo que se le había aplicado.
export async function deshacerImputaciones(manager: EntityManager, movimientoId: string) {
  const imputaciones = await manager.find(ReceiptPayment, {
    where: { cuentaMovimientoId: movimientoId },
    relations: ['receipt'],
  });
  for (const p of imputaciones) {
    if (p.receipt) {
      const actual = await manager.findOne(Receipt, { where: { id: p.receipt.id } });
      if (actual)
        await manager.update(Receipt, { id: actual.id }, {
          price: (actual.price ?? 0) + (p.price ?? 0),
          status: 'PENDING',
          paymentDate: null,
        });
    }
    await manager.delete(ReceiptPayment, { id: p.id });
  }
  return imputaciones;
}

// Pagos reales (no imputaciones de crédito) que tiene un recibo, sin contar los de un asiento.
export async function pagosRealesDe(manager: EntityManager, receiptId: string) {
  return manager.count(ReceiptPayment, {
    where: { receipt: { id: receiptId }, paymentType: Not('CREDIT' as const) },
  });
}

export async function yaAnulado(manager: EntityManager, movimientoId: string) {
  return manager.exists(CuentaMovimiento, { where: { anulaId: movimientoId } });
}
