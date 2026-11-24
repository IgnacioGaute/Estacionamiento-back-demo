import { BadRequestException } from '@nestjs/common';

// El arqueo final de la caja se cuenta por cantidad de billetes y monedas de cada denominación, no
// escribiendo un total: contar «tres de diez mil, cinco de mil…» deja menos lugar a errores de suma
// y, si hay un faltante, permite ver qué se contó. El servidor recalcula el total a partir del
// desglose y no confía solo en el que manda la pantalla.
//
// Las denominaciones de pesos en circulación, de mayor a menor, con las monedas: los importes son
// pesos enteros, así que con estas se puede representar cualquier efectivo. $10 es billete y moneda
// (se cuentan juntos). Si aparece una denominación nueva, se agrega acá y en el frontend
// (src/utils/conteo-billetes.ts); los desgloses guardados no cambian.
export const DENOMINACIONES = [20000, 10000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1] as const;

export type ConteoBillete = { denominacion: number; cantidad: number };

const MAXIMO = 1_000_000_000;

function invalido(message: string): never {
  throw new BadRequestException({ code: 'CONTEO_BILLETES_INVALIDO', message });
}

/**
 * Valida un desglose y devuelve su total y la forma en que se guarda: de mayor a menor y sin las
 * denominaciones en cero. Un desglose vacío es un conteo de $0 («No hay efectivo»).
 */
export function desgloseValido(desglose: ConteoBillete[]): { total: number; desglose: ConteoBillete[] } {
  if (!Array.isArray(desglose)) invalido('Indicá cuántos billetes contaste de cada denominación.');
  const vistas = new Set<number>();
  for (const fila of desglose) {
    if (!DENOMINACIONES.includes(fila?.denominacion as (typeof DENOMINACIONES)[number])) invalido(`$${fila?.denominacion} no es una denominación admitida.`);
    if (!Number.isInteger(fila.cantidad) || fila.cantidad < 0) invalido('Las cantidades de billetes son números enteros, sin negativos.');
    if (vistas.has(fila.denominacion)) invalido(`La denominación de $${fila.denominacion} está repetida.`);
    vistas.add(fila.denominacion);
  }
  const guardado = desglose.filter(f => f.cantidad > 0).map(f => ({ denominacion: f.denominacion, cantidad: f.cantidad }))
    .sort((a, b) => b.denominacion - a.denominacion);
  const total = guardado.reduce((s, f) => s + f.denominacion * f.cantidad, 0);
  if (total > MAXIMO) invalido('El total contado es demasiado grande. Revisá las cantidades.');
  return { total, desglose: guardado };
}

/**
 * El conteo de un arqueo final: el desglose final y el del primer conteo (el que se comparó antes de
 * ver lo esperado). Completa `efectivoContado` y `primerConteo` con los totales recalculados; si la
 * pantalla mandó un total distinto del desglose, se rechaza en vez de elegir uno.
 * Sin desglose (pantallas o pendientes sin conexión anteriores) devuelve nulls y deja los totales
 * como vinieron: quien llama decide si lo exige.
 */
export function conteoDelArqueo(dto: { desglose?: ConteoBillete[]; primerConteoDesglose?: ConteoBillete[]; efectivoContado?: number; primerConteo?: number }) {
  const final = dto.desglose ? desgloseValido(dto.desglose) : null;
  if (final) {
    if (dto.efectivoContado !== undefined && dto.efectivoContado !== final.total)
      throw new BadRequestException({ code: 'CONTEO_NO_COINCIDE', message: 'El total no coincide con los billetes contados. Revisá el conteo.' });
    dto.efectivoContado = final.total;
  }
  let primero = dto.primerConteoDesglose ? desgloseValido(dto.primerConteoDesglose) : null;
  if (primero && !final) invalido('Falta el conteo final de billetes.');
  if (primero) {
    if (dto.primerConteo !== undefined && dto.primerConteo !== primero.total)
      throw new BadRequestException({ code: 'CONTEO_NO_COINCIDE', message: 'El primer conteo no coincide con sus billetes. Revisá el conteo.' });
    dto.primerConteo = primero.total;
  } else if (final && (dto.primerConteo === undefined || dto.primerConteo === final.total)) {
    // No se corrigió: el primer conteo es el mismo.
    primero = final;
    dto.primerConteo = final.total;
  }
  // Un primer importe distinto sin su desglose se conserva como vino, sin inventarle billetes.
  return { desglose: final?.desglose ?? null, primerDesglose: primero?.desglose ?? null };
}

const pesos = (n: number) => '$' + n.toLocaleString('es-AR');

/** Qué denominaciones cambiaron entre el primer conteo y el final, para la nota del cierre. */
export function cambiosDeDesglose(antes: ConteoBillete[] | null | undefined, despues: ConteoBillete[] | null | undefined) {
  if (!antes || !despues) return null;
  const cantidad = (lista: ConteoBillete[], d: number) => lista.find(f => f.denominacion === d)?.cantidad ?? 0;
  const cambios = DENOMINACIONES.filter(d => cantidad(antes, d) !== cantidad(despues, d))
    .map(d => `${pesos(d)}: de ${cantidad(antes, d)} a ${cantidad(despues, d)}`);
  return cambios.length ? `Billetes corregidos: ${cambios.join('; ')}.` : null;
}
