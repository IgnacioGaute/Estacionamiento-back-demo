export interface ComisionesCaja {
  qrPorcentaje: number;
  transferenciaPorcentaje: number;
}

export const COMISIONES_CERO: ComisionesCaja = { qrPorcentaje: 0, transferenciaPorcentaje: 0 };
const centavos = (n: number) => Math.round((n + Number.EPSILON) * 100);

interface DatosCaja {
  totalPrice: number;
  ticketMovements?: { monto: number; metodo: string; tipo: string }[];
  ticketRegistrationForDays?: { paid: boolean; price: number; paymentMetodo?: string | null }[];
  cobrosInquilinos?: { metodo: string; monto: number }[] | null;
  receiptPayments?: { paymentType: string; price: number; cuentaMovimientoId?: string | null }[];
  paymentHistoryOnAccount?: { paymentType: string; price: number }[];
  otherPayments?: { paymentMethod?: string | null; type?: string | null; price: number }[];
}

// Sólo proyección de caja. Nunca modifica precios, movimientos ni el efectivo del cajón.
// Los porcentajes actuales recalculan el período consultado; no son cargos confirmados por MP.
export function resumenConComisiones(box: DatosCaja, config: ComisionesCaja) {
  const grupos = [
    { metodo: 'TRANSFER', etiqueta: 'Transferencias / alias', porcentaje: config.transferenciaPorcentaje, bruto: 0, comision: 0 },
    { metodo: 'MERCADOPAGO', etiqueta: 'Mercado Pago / QR', porcentaje: config.qrPorcentaje, bruto: 0, comision: 0 },
  ];
  const sumar = (metodo: string | null | undefined, monto: number, cobraComision = true) => {
    const grupo = grupos.find(g => g.metodo === (metodo === 'TP' ? 'TRANSFER' : metodo));
    if (!grupo || !Number.isFinite(Number(monto))) return;
    const importe = centavos(Number(monto));
    grupo.bruto += importe;
    // Una devolución no implica que el procesador reintegre su comisión.
    if (cobraComision && importe > 0) grupo.comision += Math.round(importe * grupo.porcentaje / 100);
  };
  for (const m of box.ticketMovements ?? []) if (m.tipo !== 'CORTESIA') sumar(m.metodo, m.monto);
  for (const t of box.ticketRegistrationForDays ?? []) if (t.paid) sumar(t.paymentMetodo, t.price);
  for (const c of box.cobrosInquilinos ?? []) sumar(c.metodo, c.monto);
  // El pago a cuenta y sus imputaciones a recibos representan el mismo dinero.
  for (const p of box.receiptPayments ?? []) if (!p.cuentaMovimientoId) sumar(p.paymentType, p.price);
  for (const p of box.paymentHistoryOnAccount ?? []) sumar(p.paymentType, p.price);
  for (const p of box.otherPayments ?? []) sumar(p.paymentMethod, p.type === 'EGRESOS' ? -p.price : p.price, p.type !== 'EGRESOS');
  const efectivo = centavos(Number(box.totalPrice));
  const digital = grupos.reduce((n, g) => n + g.bruto, 0);
  const comisiones = grupos.reduce((n, g) => n + g.comision, 0);
  return {
    criterio: 'PORCENTAJES_ACTUALES' as const,
    efectivo: efectivo / 100,
    totalAntesComisiones: (efectivo + digital) / 100,
    comisionEstimada: comisiones / 100,
    totalNetoEstimado: (efectivo + digital - comisiones) / 100,
    medios: grupos.map(g => ({ ...g, bruto: g.bruto / 100, comision: g.comision / 100, neto: (g.bruto - g.comision) / 100 })),
  };
}
