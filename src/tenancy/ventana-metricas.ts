import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { ZONA } from 'src/saas/estado-cuenta';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Dónde empieza la ventana de las métricas de la plataforma: la medianoche de Argentina de hace
 * `ventana - 1` días, así «30 días» son hoy y los 29 anteriores, los mismos que dibuja el eje del
 * front. Contando desde «ahora menos 30×24 h» entraba un pedazo del día 31: la serie diaria lo
 * agrupaba entero y el KPI lo sumaba, pero el gráfico no lo dibujaba (en la ficha de una empresa
 * daba $701k arriba y $390k en el gráfico). `periodos = 2` es el comienzo del período anterior,
 * del mismo largo.
 */
export function inicioVentana(ventana: number, periodos = 1, ahora: Date = new Date()) {
  return dayjs(ahora)
    .tz(ZONA)
    .startOf('day')
    .subtract(ventana * periodos - 1, 'day')
    .toDate();
}
