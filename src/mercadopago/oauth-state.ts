import { randomBytes } from 'node:crypto';

// El `state` de OAuth es lo único que ata la vuelta de MercadoPago a la empresa que inició la
// conexión. Sin él, cualquiera que consiga un código de autorización podría hacer que la cuenta
// que queda conectada a una empresa sea la suya.
//
// Por eso: aleatorio de 256 bits, de un solo uso, con vencimiento corto, y guardado en el
// servidor —nunca se confía en lo que vuelve por la URL más allá de usarlo como clave de búsqueda.
//
// Vive en memoria del proceso, igual que el limitador de login y el del asistente. Si mañana hay
// más de una instancia esto hay que mover a la base o a Redis: el pedido de conexión y la vuelta
// podrían caer en instancias distintas y la conexión fallaría (falla cerrada, no abierta).
const VIGENCIA_MS = 10 * 60 * 1000; // El código de MercadoPago dura 10 minutos; no tiene sentido más.
const MAXIMO = 5000;

interface Pendiente {
  empresaId: string;
  usuarioId: string;
  venceEn: number;
}

const pendientes = new Map<string, Pendiente>();

function limpiar() {
  const ahora = Date.now();
  for (const [clave, dato] of pendientes)
    if (dato.venceEn <= ahora) pendientes.delete(clave);
  // Tope de memoria: si algo genera estados sin consumirlos, se descartan los más viejos.
  while (pendientes.size > MAXIMO) {
    const primera = pendientes.keys().next();
    if (primera.done) break;
    pendientes.delete(primera.value);
  }
}

export function crearState(empresaId: string, usuarioId: string): string {
  limpiar();
  const state = randomBytes(32).toString('hex');
  pendientes.set(state, {
    empresaId,
    usuarioId,
    venceEn: Date.now() + VIGENCIA_MS,
  });
  return state;
}

/** Devuelve el pendiente y lo consume: un state sirve una sola vez, aunque el canje falle después. */
export function consumirState(state: string): Pendiente | null {
  limpiar();
  const dato = pendientes.get(state);
  if (!dato) return null;
  pendientes.delete(state);
  return dato.venceEn > Date.now() ? dato : null;
}
