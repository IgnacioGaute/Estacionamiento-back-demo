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
// El ciclo: alta → días de prueba (opcionales) → al terminar la prueba se emite la factura del
// primer mes, que vence ese mismo día → desde ahí se cuentan los días de atraso → con más de
// DIAS_DE_GRACIA de atraso se suspende. Cada mes pago corre el vencimiento un mes.
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

/** Cortada por falta de pago: no tuvo el servicio, así que no se le cobra ese tiempo. */
export const cortadaPorFaltaDePago = (d: DatosCuenta) =>
  d.empresaEstado !== 'ACTIVA' && d.motivoSuspension === 'FALTA_DE_PAGO';

/** El período que sigue al último día cubierto: el de la próxima factura. */
export const periodoSiguiente = (venceEl: string, meses = 1) => ({
  desde: sumarDias(venceEl, 1),
  hasta: sumarMeses(venceEl, meses),
});

/**
 * El período que cubre un pago de `meses` meses. Si venía usando el sistema (al día, en prueba
 * o atrasada sin cortar) sigue desde su vencimiento, aunque pague tarde: el aniversario no se
 * mueve. Si estaba cortada, o nunca tuvo vencimiento, arranca el día del pago.
 */
export function periodoDelPago(
  d: DatosCuenta,
  meses: number,
  hoy = hoyAR(),
): { desde: string; hasta: string } {
  const ultimo = d.pagadoHasta ?? d.pruebaHasta;
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
