export const CLAVES_COMISION = ['qrSaldo', 'qrDebito', 'qrCredito', 'aliasSaldo', 'aliasDebito', 'aliasCredito'] as const;
export type ClaveComision = typeof CLAVES_COMISION[number];
export type ComisionesCaja = Record<ClaveComision, number | null>;
// QR al instante + IVA 21%, referencia pública consultada el 08/10/2026.
// Alias crédito: no hay tasa argentina verificada para el receptor.
export const COMISIONES_REFERENCIA: ComisionesCaja = {
  qrSaldo: 0.968, qrDebito: 1.6335, qrCredito: 7.2479,
  aliasSaldo: 0, aliasDebito: 0, aliasCredito: null,
};
export const COMISIONES_CERO: ComisionesCaja = {
  qrSaldo: 0, qrDebito: 0, qrCredito: 0, aliasSaldo: 0, aliasDebito: 0, aliasCredito: 0,
};
export function tipoDePagoMp(p: { payment_type_id?: string; payment_method?: { type?: string } }): string | null {
  return p.payment_type_id ?? p.payment_method?.type ?? null;
}
export function claveComision(canal: 'QR' | 'ALIAS', tipo: string | null | undefined): ClaveComision | null {
  const prefijo = canal === 'QR' ? 'qr' : 'alias';
  if (tipo === 'credit_card') return `${prefijo}Credito`;
  if (tipo === 'debit_card') return `${prefijo}Debito`;
  if (tipo === 'account_money' || tipo === 'bank_transfer') return `${prefijo}Saldo`;
  return null;
}
const centavos = (n: number) => Math.round((n + Number.EPSILON) * 100);
const ETIQUETAS: Record<ClaveComision, string> = {
  qrSaldo: 'QR · saldo / transferencia', qrDebito: 'QR · débito', qrCredito: 'QR · crédito',
  aliasSaldo: 'Alias MP · transferencia', aliasDebito: 'Alias MP · débito', aliasCredito: 'Alias MP · crédito',
};
type Clasificacion = ClaveComision | 'qrDesconocido' | 'aliasDesconocido';
export interface EvidenciaComisiones {
  movimientos: Map<string, Clasificacion>;
  abonos: Map<string, Clasificacion>;
  inquilinos: Map<string, Clasificacion>;
}
interface DatosCaja {
  totalPrice: number;
  ticketMovements?: { id?: string; monto: number; metodo: string; tipo: string }[];
  ticketRegistrationForDays?: { id?: string; paid: boolean; price: number; paymentMetodo?: string | null }[];
  cobrosInquilinos?: { id?: string; metodo: string; monto: number }[] | null;
  receiptPayments?: { paymentType: string; price: number; cuentaMovimientoId?: string | null }[];
  paymentHistoryOnAccount?: { paymentType: string; price: number }[];
  otherPayments?: { paymentMethod?: string | null; type?: string | null; price: number }[];
}
// Sólo comisiona operaciones respaldadas por cobros de la cuenta MP de la empresa.
// TRANSFER manual sigue sumando dinero, pero nunca hereda comisiones de Mercado Pago.
export function resumenConComisiones(box: DatosCaja, config: ComisionesCaja, evidencia: EvidenciaComisiones = { movimientos: new Map(), abonos: new Map(), inquilinos: new Map() }) {
  const grupos = [
    ...CLAVES_COMISION.map(metodo => ({ metodo: metodo as string, etiqueta: ETIQUETAS[metodo], porcentaje: config[metodo], bruto: 0, comision: 0, pendiente: 0 })),
    { metodo: 'qrDesconocido', etiqueta: 'QR · medio no informado', porcentaje: null, bruto: 0, comision: 0, pendiente: 0 },
    { metodo: 'aliasDesconocido', etiqueta: 'Alias MP · medio no informado', porcentaje: null, bruto: 0, comision: 0, pendiente: 0 },
    { metodo: 'TRANSFER', etiqueta: 'Otras transferencias', porcentaje: 0, bruto: 0, comision: 0, pendiente: 0 },
  ];
  const sumar = (metodo: string | null | undefined, monto: number, clasificacion?: Clasificacion) => {
    if (!['TRANSFER', 'TP', 'MERCADOPAGO'].includes(metodo ?? '') || !Number.isFinite(Number(monto))) return;
    const grupo = grupos.find(g => g.metodo === (clasificacion ?? (metodo === 'MERCADOPAGO' ? 'qrDesconocido' : 'TRANSFER')))!;
    const importe = centavos(Number(monto));
    grupo.bruto += importe;
    if (importe > 0) {
      if (grupo.porcentaje === null) grupo.pendiente += importe;
      else grupo.comision += Math.round(importe * grupo.porcentaje / 100);
    }
  };
  for (const m of box.ticketMovements ?? []) if (m.tipo !== 'CORTESIA') sumar(m.metodo, m.monto, evidencia.movimientos.get(m.id ?? ''));
  for (const t of box.ticketRegistrationForDays ?? []) if (t.paid) sumar(t.paymentMetodo, t.price, evidencia.abonos.get(t.id ?? ''));
  for (const c of box.cobrosInquilinos ?? []) sumar(c.metodo, c.monto, evidencia.inquilinos.get(c.id ?? ''));
  for (const p of box.receiptPayments ?? []) if (!p.cuentaMovimientoId) sumar(p.paymentType, p.price);
  for (const p of box.paymentHistoryOnAccount ?? []) sumar(p.paymentType, p.price);
  for (const p of box.otherPayments ?? []) sumar(p.paymentMethod, p.type === 'EGRESOS' ? -p.price : p.price);
  const efectivo = centavos(Number(box.totalPrice));
  const digital = grupos.reduce((n, g) => n + g.bruto, 0);
  const comisiones = grupos.reduce((n, g) => n + g.comision, 0);
  return {
    criterio: 'PORCENTAJES_ACTUALES' as const,
    efectivo: efectivo / 100,
    totalAntesComisiones: (efectivo + digital) / 100,
    comisionEstimada: comisiones / 100,
    totalNetoEstimado: (efectivo + digital - comisiones) / 100,
    importePendienteComision: grupos.reduce((n, g) => n + g.pendiente, 0) / 100,
    medios: grupos.filter(g => g.bruto || g.comision || g.pendiente).map(g => ({ ...g, bruto: g.bruto / 100, comision: g.comision / 100, pendiente: g.pendiente / 100, neto: (g.bruto - g.comision) / 100 })),
  };
}