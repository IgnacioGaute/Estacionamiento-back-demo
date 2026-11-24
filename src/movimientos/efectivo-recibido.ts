import { BadRequestException } from '@nestjs/common';

// Lo que el operador declaró recibir en billetes por la parte en efectivo de un cobro, y el vuelto
// que corresponde. Explica el cobro: no es un ingreso ni un egreso del libro. El dinero que entra a
// la caja sigue siendo el importe aplicado (el monto del movimiento en efectivo); recibido y vuelto
// se guardan al lado para revisar un faltante («¿con cuánto pagó?», «¿cuánto vuelto le di?»). Son
// datos declarados: no prueban que ese dinero se haya recibido o entregado.
//
// Ejemplo de un pago mixto: total $5.000, $2.000 en efectivo y $3.000 por transferencia. Si el
// cliente entrega un billete de $5.000, recibido = 5.000 y vuelto = 3.000: a la caja entran $2.000.
export type EfectivoDeclarado = { efectivoRecibido: number; vuelto: number };

/**
 * Valida lo recibido contra el efectivo aplicado y calcula el vuelto en el servidor.
 *
 * - Sin efectivo aplicado no corresponde declarar billetes.
 * - Es opcional: el cobro en efectivo se confirma directo y «Calcular vuelto» es una ayuda. Si no
 *   se usó, recibido y vuelto quedan sin informar (null): nunca se asume que pagó justo.
 * - Si se informa, no puede ser menor que lo aplicado: la diferencia no se convierte en descuento
 *   ni en deuda; se corrige el importe o se cobra el resto con otro medio (pago mixto).
 */
export function efectivoDeclarado(aplicado: number, recibido: number | null | undefined): EfectivoDeclarado | null {
  const declarado = recibido ?? undefined;
  if (aplicado <= 0) {
    if (declarado !== undefined) throw new BadRequestException({ code: 'EFECTIVO_RECIBIDO_SIN_EFECTIVO', message: 'Lo que entrega el cliente se indica solo cuando paga en efectivo.' });
    return null;
  }
  if (declarado === undefined) return null;
  if (!Number.isInteger(declarado) || declarado < 0) throw new BadRequestException({ code: 'EFECTIVO_RECIBIDO_INVALIDO', message: 'Lo que entrega el cliente va en pesos enteros.' });
  if (declarado < aplicado) {
    throw new BadRequestException({
      code: 'EFECTIVO_INSUFICIENTE',
      message: `Lo que entrega ($${declarado.toLocaleString('es-AR')}) no alcanza para los $${aplicado.toLocaleString('es-AR')} en efectivo. Corregí el importe o cobrá el resto con otro medio.`,
    });
  }
  return { efectivoRecibido: declarado, vuelto: declarado - aplicado };
}
