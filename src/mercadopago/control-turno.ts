// El control de Mercado Pago de un turno, sin base ni MercadoPago para probarlo de a una regla
// (control-turno.spec.ts). Compara cuánto entró a la cuenta entre la apertura y el cierre con lo
// que el sistema registró por Mercado Pago y transferencias en ese mismo horario.
//
// Si entró más a Mercado Pago de lo registrado, lo más común es un pago por transferencia cargado
// como efectivo: es la plata que «falta» en la caja. Se guardan solo los totales.

import { esTransferenciaRecibida } from './coincidencias';

export type TotalesRecibidos = {
  total: number;
  transferencias: number;
  qr: number;
  otros: number;
  cantidad: number;
};

export type TotalesRegistrados = {
  total: number;
  alias: number;
  qr: number;
  transferencias: number;
};

const pesos = (n: number) => Math.round(n);

/**
 * Lo que entró a la cuenta en [desde, hasta]: acreditado, en pesos, cobrado por esta cuenta. Las
 * transferencias al alias o entre cuentas son «transferencias»; lo que generó una integración (los
 * cobros con QR del sistema llevan `external_reference`) es «qr»; el resto (QR fijo, tarjeta, otros
 * ingresos) va en «otros». Lo que paga la cuenta no entra.
 */
export function totalesRecibidos(
  pagos: any[],
  mpUserId: string,
  desde: Date,
  hasta: Date,
): TotalesRecibidos {
  const t = { total: 0, transferencias: 0, qr: 0, otros: 0, cantidad: 0 };
  const vistos = new Set<string>();
  for (const p of pagos) {
    if (p?.collector_id == null || String(p.collector_id) !== String(mpUserId)) continue;
    if (p.status !== 'approved' || p.currency_id !== 'ARS') continue;
    const importe = Number(p.transaction_amount);
    if (!(importe > 0)) continue;
    const momento = new Date(p.date_approved ?? p.date_created).getTime();
    if (!(momento >= desde.getTime() && momento <= hasta.getTime())) continue;
    // La búsqueda pagina por fecha: si un pago entra mientras se pagina, puede venir dos veces.
    const id = String(p.id ?? '');
    if (id && vistos.has(id)) continue;
    if (id) vistos.add(id);
    t.cantidad += 1;
    t.total += importe;
    if (esTransferenciaRecibida(p, mpUserId)) t.transferencias += importe;
    else if (p.external_reference) t.qr += importe;
    else t.otros += importe;
  }
  return {
    total: pesos(t.total),
    transferencias: pesos(t.transferencias),
    qr: pesos(t.qr),
    otros: pesos(t.otros),
    cantidad: t.cantidad,
  };
}

/** Lo registrado por medio, como lo agrupa el resumen del turno (QR, ALIAS y el resto manual). */
export function totalesRegistrados(
  filas: { medio: string; total: string | number }[],
): TotalesRegistrados {
  const t = { total: 0, alias: 0, qr: 0, transferencias: 0 };
  for (const f of filas) {
    const monto = Number(f.total) || 0;
    if (f.medio === 'QR') t.qr += monto;
    else if (f.medio === 'ALIAS') t.alias += monto;
    // Un cheque no pasa por Mercado Pago.
    else if (f.medio === 'TRANSFER') t.transferencias += monto;
    else continue;
    t.total += monto;
  }
  return t;
}
