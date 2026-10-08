import { PricingBracket, PricingSchedule } from './pricing/pricing.types';

type Plan = { schedule: PricingSchedule; brackets: PricingBracket[] };
type Cambio = { de: unknown; a: unknown };

// Qué cambió entre dos planes de tarifas, para el historial de la empresa (audit_log). El editor
// aplica el plan entero de una vez, así que sin esta comparación el historial solo podría decir
// «aplicó las tarifas» y no «subió la hora de Auto de $1.200 a $1.500».
//
// Las rutas siguen la forma que el panel ya lee (`seccion.campo`, una hoja por cambio). Lo que
// identifica a una fila de una lista —el vehículo, la franja— va entre « » para que el panel lo
// muestre como nombre y no lo tome por una sección. Una franja nueva es `de: null` y una quitada
// `a: null`.
export function cambiosDeTarifas(
  antes: Plan,
  despues: Plan,
  vehiculos: { code: string; name: string }[],
): Record<string, Cambio> {
  const salida: Record<string, Cambio> = {};
  const anotar = (ruta: string, de: unknown, a: unknown) => {
    if (JSON.stringify(de ?? null) !== JSON.stringify(a ?? null))
      salida[ruta] = { de: de ?? null, a: a ?? null };
  };
  const vehiculo = (code: string) =>
    vehiculos.find((v) => v.code === code)?.name ?? code;
  // Un punto partiría la ruta en el panel: «1.5 h» queda «1,5 h».
  const etiqueta = (texto: string) => `«${texto.replace(/\./g, ',')}»`;
  const franja = (b: PricingBracket) =>
    etiqueta(
      `${vehiculo(b.vehicleType)} · ${b.label}${
        b.ticketDayType ? ` · ${b.ticketDayType === 'DAY' ? 'día' : 'noche'}` : ''
      }`,
    );

  for (const campo of [
    'dayStartHour',
    'dayEndHour',
    'graceMinutes',
    'pricingDayTypeBasis',
  ] as const)
    anotar(campo, antes.schedule[campo], despues.schedule[campo]);

  const cobroAntes = antes.schedule.pricingOptions?.charging;
  const cobroDespues = despues.schedule.pricingOptions?.charging;
  for (const campo of ['enabled', 'mode', 'unitMinutes'] as const)
    anotar(
      `pricingOptions.charging.${campo}`,
      cobroAntes?.[campo],
      cobroDespues?.[campo],
    );
  const codigos = new Set(
    [...(cobroAntes?.rates ?? []), ...(cobroDespues?.rates ?? [])].map(
      (r) => r.vehicleType,
    ),
  );
  for (const code of codigos) {
    const previa = cobroAntes?.rates.find((r) => r.vehicleType === code);
    const nueva = cobroDespues?.rates.find((r) => r.vehicleType === code);
    for (const campo of ['dayPrice', 'nightPrice'] as const)
      anotar(
        `pricingOptions.charging.${etiqueta(vehiculo(code))}.${campo}`,
        previa?.[campo],
        nueva?.[campo],
      );
  }

  const cruceAntes = antes.schedule.pricingOptions?.crossing;
  const cruceDespues = despues.schedule.pricingOptions?.crossing;
  for (const campo of ['enabled', 'mode'] as const)
    anotar(
      `pricingOptions.crossing.${campo}`,
      cruceAntes?.[campo],
      cruceDespues?.[campo],
    );
  // Las reglas de permanencia están retiradas: el servicio las guarda siempre apagadas y no hay
  // nada que contar de ellas.

  // Las franjas se reconocen por id: el servicio lo conserva al editar, así que una franja que
  // cambió de nombre sigue siendo la misma y no aparece como quitada y agregada.
  const quedan = new Set(despues.brackets.map((b) => b.id));
  for (const nueva of despues.brackets) {
    const ruta = `franjas.${franja(nueva)}`;
    const previa = antes.brackets.find((b) => b.id === nueva.id);
    if (!previa) {
      anotar(`${ruta}.price`, null, nueva.price);
      continue;
    }
    for (const campo of [
      'label',
      'ticketDayType',
      'uptoMinutes',
      'price',
      'recurringUnitMinutes',
      'recurringPriceMode',
    ] as const)
      anotar(`${ruta}.${campo}`, previa[campo], nueva[campo]);
  }
  for (const previa of antes.brackets)
    if (!quedan.has(previa.id))
      anotar(`franjas.${franja(previa)}.price`, previa.price, null);

  return salida;
}
