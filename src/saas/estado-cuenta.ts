import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import type { EmpresaEstado } from 'src/tenancy/entities/empresa.entity';
import type { MotivoSuspension } from './entities/suscripcion.entity';

dayjs.extend(utc);
dayjs.extend(timezone);

// Las reglas del ciclo de vida de la cuenta de una empresa con la plataforma, sin base de datos:
// se usan igual en el resumen que ve el panel, en la tarea diaria y al registrar un pago, y así
// se pueden probar solas.
//
// El ciclo: alta → días de prueba gratis (opcionales) → al terminar la prueba se emite el primer
// pago, que vence ese mismo día y cubre lo que queda del mes, en proporción → desde ahí cada
// período arranca el día 1 → con más de DIAS_DE_GRACIA de atraso se suspende.
//
// Todas las fechas son días de Argentina ("YYYY-MM-DD") y se comparan como texto.

export const ZONA = 'America/Argentina/Buenos_Aires';
export const DIAS_DE_PRUEBA = 7;
// Días de atraso que se toleran: con uno más, se suspende.
export const DIAS_DE_GRACIA = 5;
// Con débito automático activo: MercadoPago reintenta un cobro rechazado hasta 4 veces en 10 días,
// así que no se suspende a alguien a quien todavía le están cobrando.
export const DIAS_DE_GRACIA_DEBITO = 10;
// Suspendida por falta de pago durante tanto tiempo, pasa a baja. Los datos se conservan.
export const DIAS_HASTA_BAJA = 60;

export const hoyAR = () => dayjs().tz(ZONA).format('YYYY-MM-DD');

export const sumarDias = (fecha: string, dias: number) =>
  dayjs(fecha).add(dias, 'day').format('YYYY-MM-DD');

export const diasEntre = (desde: string, hasta: string) =>
  dayjs(hasta).diff(dayjs(desde), 'day');

/**
 * Un mes más, manteniendo el aniversario. Si el vencimiento cae a fin de mes, sigue cayendo a fin
 * de mes: sin esto, el que arrancó un 31 terminaría pagando el 28 para siempre después de febrero.
 */
export function sumarMeses(fecha: string, meses: number) {
  const base = dayjs(fecha);
  const destino = base.add(meses, 'month');
  return base.date() === base.daysInMonth()
    ? destino.endOf('month').format('YYYY-MM-DD')
    : destino.format('YYYY-MM-DD');
}

const mayor = (...fechas: (string | null | undefined)[]) =>
  fechas
    .filter((f): f is string => !!f)
    .sort()
    .pop() ?? null;

/**
 * Último día de prueba para un alta con `dias` días gratis: el alta cuenta como el primero. Con
 * 0 días queda el día anterior al alta, así la primera factura vence el mismo día del alta.
 */
export const finDePrueba = (alta: string, dias: number) =>
  sumarDias(alta, dias - 1);

export const ESTADO_CUENTA = [
  'SIN_ACTIVAR',
  'BONIFICADA',
  'PRUEBA',
  'AL_DIA',
  'VENCIDA',
  'SUSPENDIDA',
  'BAJA',
] as const;
export type EstadoCuenta = (typeof ESTADO_CUENTA)[number];

export type DatosCuenta = {
  empresaEstado: EmpresaEstado;
  alta: string;
  bonificada: boolean;
  pruebaHasta: string | null;
  pagadoHasta: string | null;
  prorrogaHasta: string | null;
  motivoSuspension: MotivoSuspension | null;
  // Tiene el débito automático de MercadoPago autorizado.
  conDebito?: boolean;
};

export type SituacionCuenta = {
  estado: EstadoCuenta;
  // Último día cubierto: lo pagado o, si nunca pagó, la prueba.
  venceEl: string | null;
  // El día siguiente: el de la factura del período que sigue, que vence ese mismo día.
  proximoVencimiento: string | null;
  // Días hasta el próximo vencimiento (negativo si ya pasó).
  diasParaVencer: number | null;
  // Días que pasaron desde el vencimiento sin pagar. 0 si no venció o vence hoy.
  diasDeAtraso: number;
  // Primer día en que la tarea diaria la suspende si sigue sin pagar.
  suspendeEl: string | null;
  enPrueba: boolean;
  // Vencida, pasada la gracia y los días extra, y todavía con acceso.
  debeSuspenderse: boolean;
  // Días de atraso que se toleran para esta cuenta (más con débito automático).
  diasDeGracia: number;
};

export function situacionDeCuenta(
  d: DatosCuenta,
  hoy = hoyAR(),
): SituacionCuenta {
  const venceEl = d.pagadoHasta ?? d.pruebaHasta;
  const proximoVencimiento = venceEl ? sumarDias(venceEl, 1) : null;
  const enPrueba = !d.pagadoHasta && !!d.pruebaHasta && d.pruebaHasta >= d.alta;
  // Los días extra (prórroga) corren el corte, no el vencimiento: la próxima factura sigue
  // arrancando donde terminó lo pagado y los días de atraso se siguen contando.
  const diasDeGracia = d.conDebito ? DIAS_DE_GRACIA_DEBITO : DIAS_DE_GRACIA;
  const ultimoConAcceso = proximoVencimiento
    ? mayor(sumarDias(proximoVencimiento, diasDeGracia), d.prorrogaHasta)
    : null;
  const diasDeAtraso =
    proximoVencimiento && hoy > proximoVencimiento
      ? diasEntre(proximoVencimiento, hoy)
      : 0;
  const base = {
    venceEl,
    proximoVencimiento,
    diasParaVencer: proximoVencimiento
      ? diasEntre(hoy, proximoVencimiento)
      : null,
    diasDeAtraso,
    suspendeEl: ultimoConAcceso ? sumarDias(ultimoConAcceso, 1) : null,
    enPrueba,
    debeSuspenderse: false,
    diasDeGracia,
  };
  if (d.empresaEstado === 'BAJA') return { ...base, estado: 'BAJA' };
  if (d.empresaEstado === 'SUSPENDIDA')
    return { ...base, estado: 'SUSPENDIDA' };
  if (d.bonificada)
    return { ...base, estado: 'BONIFICADA', suspendeEl: null, diasDeAtraso: 0 };
  // Sin alta de la cuenta (ni prueba ni pago): no vence hasta que se la active.
  if (!venceEl) return { ...base, estado: 'SIN_ACTIVAR', suspendeEl: null };
  if (hoy <= venceEl)
    return { ...base, estado: enPrueba ? 'PRUEBA' : 'AL_DIA' };
  return {
    ...base,
    estado: 'VENCIDA',
    debeSuspenderse: !!ultimoConAcceso && hoy > ultimoConAcceso,
  };
}

/**
 * Lo que se paga por un período: lo mensual por los meses, con el descuento del período (un
 * porcentaje entero). Redondeado a pesos, como lo muestra la landing.
 */
export const importeDelPeriodo = (
  mensual: number,
  meses: number,
  descuento: number,
) => Math.round((mensual * meses * (100 - descuento)) / 100);

export const finDeMes = (fecha: string) =>
  dayjs(fecha).endOf('month').format('YYYY-MM-DD');

/**
 * Lo que se paga por un tramo que no es un período entero: de cada mes que toca, la parte de sus
 * días (13 al 31 de octubre son 19 de 31), con el descuento de su período. Un mes entero da
 * exactamente lo mensual.
 */
export function importeProporcional(
  mensual: number,
  descuento: number,
  desde: string,
  hasta: string,
) {
  let total = 0;
  let dia = dayjs(desde);
  const fin = dayjs(hasta);
  while (!dia.isAfter(fin, 'day')) {
    const finDelMes = dia.endOf('month').startOf('day');
    const corte = finDelMes.isBefore(fin) ? finDelMes : fin;
    total += (mensual * (corte.diff(dia, 'day') + 1)) / dia.daysInMonth();
    dia = corte.add(1, 'day');
  }
  return Math.round((total * (100 - descuento)) / 100);
}

/**
 * El primer pago de una cuenta que nunca pagó: desde el día siguiente a la prueba (que es gratis)
 * hasta fin de ese mes, en proporción. Así el siguiente arranca el día 1. Sin días de prueba,
 * desde el alta. Si la prueba termina el último día del mes, es el mes siguiente entero.
 */
export const primerPeriodo = (alta: string, pruebaHasta: string | null) => {
  const finPrueba = pruebaHasta ? sumarDias(pruebaHasta, 1) : alta;
  const desde = finPrueba > alta ? finPrueba : alta;
  return { desde, hasta: finDeMes(desde) };
};

export type PeriodoAFacturar = {
  desde: string;
  hasta: string;
  // El primer pago, en proporción a sus días; los demás son períodos enteros.
  proporcional: boolean;
};

/**
 * El período de la próxima factura: el primer pago si nunca pagó, o el que sigue a lo pagado.
 * Null si la cuenta todavía no arrancó (sin alta).
 */
export function proximoPeriodo(
  d: Pick<DatosCuenta, 'alta' | 'pruebaHasta' | 'pagadoHasta'>,
  meses = 1,
): PeriodoAFacturar | null {
  if (d.pagadoHasta)
    return { ...periodoSiguiente(d.pagadoHasta, meses), proporcional: false };
  if (!d.pruebaHasta) return null;
  return { ...primerPeriodo(d.alta, d.pruebaHasta), proporcional: true };
}

/** Lo que cuesta un período a facturar: el proporcional del primero o el período entero. */
export const importeDeFactura = (
  periodo: PeriodoAFacturar,
  mensual: number,
  meses: number,
  descuento: number,
) =>
  periodo.proporcional
    ? importeProporcional(mensual, descuento, periodo.desde, periodo.hasta)
    : importeDelPeriodo(mensual, meses, descuento);

/** Cortada por falta de pago: no tuvo el servicio, así que no se le cobra ese tiempo. */
export const cortadaPorFaltaDePago = (d: DatosCuenta) =>
  d.empresaEstado !== 'ACTIVA' && d.motivoSuspension === 'FALTA_DE_PAGO';

/** El período que sigue al último día cubierto: el de la próxima factura. */
export const periodoSiguiente = (venceEl: string, meses = 1) => ({
  desde: sumarDias(venceEl, 1),
  hasta: sumarMeses(venceEl, meses),
});

/**
 * El período que cubre un pago de `meses` meses. El primero de una cuenta con prueba es siempre el
 * primer pago (del fin de la prueba a fin de ese mes), aunque llegue tarde o con la cuenta
 * cortada: es la factura que tenía a la vista. Después, si venía usando el sistema (al día o
 * atrasada sin cortar) sigue desde su vencimiento, aunque pague tarde. Si estaba cortada, o nunca
 * tuvo vencimiento, arranca el día del pago.
 */
export function periodoDelPago(
  d: DatosCuenta,
  meses: number,
  hoy = hoyAR(),
): { desde: string; hasta: string } {
  if (!d.pagadoHasta && d.pruebaHasta)
    return primerPeriodo(d.alta, d.pruebaHasta);
  const ultimo = d.pagadoHasta;
  if (!ultimo || cortadaPorFaltaDePago(d))
    return { desde: hoy, hasta: sumarDias(sumarMeses(hoy, meses), -1) };
  return periodoSiguiente(ultimo, meses);
}

/**
 * Si ya corresponde tener emitida la factura del período siguiente: el día en que empieza (al
 * terminar la prueba o lo pagado), que es también el día en que vence.
 */
export function correspondeFactura(d: DatosCuenta, hoy = hoyAR()) {
  const venceEl = d.pagadoHasta ?? d.pruebaHasta;
  return (
    !d.bonificada && d.empresaEstado !== 'BAJA' && !!venceEl && hoy > venceEl
  );
}
