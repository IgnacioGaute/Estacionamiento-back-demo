// Las reglas de la verificación de transferencias al alias, sin base ni MercadoPago, para poder
// probarlas de a una (coincidencias.spec.ts). Ver docs/verificacion-transferencias.md.
//
// Importe y hora son una heurística: una coincidencia única puede ser una transferencia ajena o
// un pago demorado de otro cliente. Por eso la confirmación automática se registra como lo que es
// (AUTOMATICO_COINCIDENCIA_UNICA) y ante cualquier duda el sistema no elige: pasa a revisión.

// Un pago cancelado o vencido sigue compitiendo por las transferencias que entren hasta este rato
// después de cerrarse: puede ser el cliente que pagó tarde, y no se le puede dar su plata a otro.
export const GRACIA_PAGO_TARDIO_MS = 30 * 60 * 1000;

/** Lo que se necesita de una transferencia para decidir. */
export interface TransferenciaParaDecidir {
  operacionId: string;
  importe: number;
  moneda: string;
  fechaOperacion: Date;
  estado: 'DISPONIBLE' | 'REVISION' | 'USADA';
}

/** Lo que se necesita de un intento de cobro para decidir. */
export interface IntentoParaDecidir {
  id: string;
  importe: number;
  moneda: string;
  estado:
    | 'ESPERANDO'
    | 'REVISION'
    | 'CONFIRMADO'
    | 'CANCELADO'
    | 'VENCIDO'
    | 'PAGADO_OTRO_MEDIO';
  buscarDesde: Date;
  cerradoEl: Date | null;
}

export type Decision =
  | { tipo: 'ESPERAR' }
  | { tipo: 'CONFIRMAR'; operacionId: string }
  | {
      tipo: 'REVISION';
      motivo: 'VARIAS_TRANSFERENCIAS' | 'VARIOS_COBROS' | 'YA_EN_REVISION';
      operaciones: string[];
    };

const mismoImporte = (a: number, b: number) => Math.abs(a - b) < 0.005;

const nombreCompleto = (persona: any) =>
  [persona?.first_name, persona?.last_name]
    .filter((v) => typeof v === 'string' && v.trim())
    .join(' ');

// Claves que, donde aparezcan, traen el nombre de una persona. La app de MercadoPago muestra el
// nombre de quien transfiere; en la API no siempre viene en `payer`, así que se busca también en
// los datos bancarios y en cualquier rama con estos nombres.
const CLAVES_DE_NOMBRE = [
  'account_holder_name',
  'holder_name',
  'payer_name',
  'owner_name',
  'sender_name',
  'counterpart_name',
];

function buscarNombre(objeto: unknown, profundidad = 0): string | null {
  if (!objeto || typeof objeto !== 'object' || profundidad > 6) return null;
  for (const [clave, valor] of Object.entries(objeto)) {
    if (
      CLAVES_DE_NOMBRE.includes(clave) &&
      typeof valor === 'string' &&
      valor.trim()
    )
      return valor.trim();
  }
  for (const valor of Object.values(objeto)) {
    const encontrado = buscarNombre(valor, profundidad + 1);
    if (encontrado) return encontrado;
  }
  return null;
}

/**
 * Lo que se puede mostrar de quien pagó, para reconocer la transferencia en el momento. No se
 * guarda. `entidad` es el banco o la billetera de origen, si MercadoPago la informa.
 */
export function datosDelPagador(p: any) {
  const banco = p?.point_of_interaction?.transaction_data?.bank_info;
  const identificacion = p?.payer?.identification;
  return {
    nombre:
      nombreCompleto(p?.payer) ||
      nombreCompleto(p?.additional_info?.payer) ||
      buscarNombre(p) ||
      null,
    documento: identificacion?.number
      ? `${identificacion.type ?? ''} ${identificacion.number}`.trim()
      : null,
    entidad: banco?.payer?.long_name ?? null,
  };
}

// Para encontrar dónde viene el nombre en una respuesta real: las hojas cuyo camino habla de
// quien pagó (nombres, documento, banco). Se dejan afuera números de cuenta, CBU y CVU, que no
// hacen falta para reconocer a nadie.
const RUTA_DE_PAGADOR =
  /payer|holder|name|nombre|identification|bank_info|counterpart|sender|owner/i;
const RUTA_EXCLUIDA = /account_id|account_number|cbu|cvu|card|token|email/i;

export function camposDelPagador(
  objeto: unknown,
  ruta = '',
  salida: { ruta: string; valor: string }[] = [],
) {
  if (!objeto || typeof objeto !== 'object' || salida.length >= 60)
    return salida;
  for (const [clave, valor] of Object.entries(objeto)) {
    const aca = ruta ? `${ruta}.${clave}` : clave;
    if (valor && typeof valor === 'object')
      camposDelPagador(valor, aca, salida);
    else if (
      valor !== null &&
      valor !== '' &&
      RUTA_DE_PAGADOR.test(aca) &&
      !RUTA_EXCLUIDA.test(aca)
    )
      salida.push({ ruta: aca, valor: String(valor).slice(0, 120) });
    if (salida.length >= 60) break;
  }
  return salida;
}

/**
 * Si un pago de MercadoPago es un ingreso por transferencia a esta cuenta. Se exige todo junto:
 * que lo haya cobrado esta cuenta, que esté acreditado, en pesos y con importe, que no lo haya
 * generado una integración (los cobros con QR del sistema llevan `external_reference`) y que sea
 * una transferencia: al CVU/alias (observado: `PSP_TRANSFER` + `bank_transfer`) o entre cuentas de
 * MercadoPago (`money_transfer`, documentado pero todavía no observado en la prueba). Tarjetas,
 * suscripciones, pagos con QR y egresos quedan afuera.
 */
export function esTransferenciaRecibida(p: any, mpUserId: string): boolean {
  if (p?.collector_id == null || String(p.collector_id) !== String(mpUserId))
    return false;
  if (p.status !== 'approved') return false;
  if (p.currency_id !== 'ARS') return false;
  if (!(Number(p.transaction_amount) > 0)) return false;
  if (p.external_reference) return false;
  const alCvu =
    p.point_of_interaction?.type === 'PSP_TRANSFER' &&
    p.payment_type_id === 'bank_transfer';
  const entreCuentas = p.operation_type === 'money_transfer';
  return alCvu || entreCuentas;
}

/**
 * Si un intento compite por una transferencia: mismo importe y moneda, y estaba buscando cuando se
 * hizo. Un intento confirmado ya tiene la suya y no compite. Uno cancelado, vencido o pagado por
 * otro medio compite (sin poder recibirla) por lo que entre hasta GRACIA_PAGO_TARDIO_MS después de
 * cerrarse: si no, un pago tardío se le daría al cobro siguiente del mismo importe.
 */
export function compite(
  i: IntentoParaDecidir,
  t: TransferenciaParaDecidir,
): boolean {
  if (i.estado === 'CONFIRMADO') return false;
  if (!mismoImporte(i.importe, t.importe) || i.moneda !== t.moneda)
    return false;
  if (t.fechaOperacion.getTime() < i.buscarDesde.getTime()) return false;
  if (i.cerradoEl == null) return true;
  return (
    t.fechaOperacion.getTime() <= i.cerradoEl.getTime() + GRACIA_PAGO_TARDIO_MS
  );
}

/**
 * Qué hacer con un intento abierto, mirando las transferencias que entraron a la cuenta y los
 * intentos de TODAS las playas que cobran con ella.
 *
 * Se confirma solo si hay exactamente una transferencia candidata, nunca estuvo en revisión, y
 * ningún otro intento compite por ella. Con cualquier duda, revisión: el operador pregunta quién
 * transfirió y elige. Un intento que ya pasó a revisión no vuelve a confirmarse solo.
 */
export function decidir(
  intento: IntentoParaDecidir,
  transferencias: TransferenciaParaDecidir[],
  intentosDeLaCuenta: IntentoParaDecidir[],
): Decision {
  const abierto = { ...intento, cerradoEl: null };
  const candidatas = transferencias.filter(
    (t) => t.estado !== 'USADA' && compite(abierto, t),
  );
  if (candidatas.length === 0) return { tipo: 'ESPERAR' };
  const operaciones = candidatas.map((t) => t.operacionId);
  if (intento.estado === 'REVISION')
    return { tipo: 'REVISION', motivo: 'YA_EN_REVISION', operaciones };
  if (candidatas.length > 1)
    return { tipo: 'REVISION', motivo: 'VARIAS_TRANSFERENCIAS', operaciones };
  const [t] = candidatas;
  if (t.estado === 'REVISION')
    return { tipo: 'REVISION', motivo: 'YA_EN_REVISION', operaciones };
  const rivales = intentosDeLaCuenta.filter(
    (i) => i.id !== intento.id && compite(i, t),
  );
  if (rivales.length > 0)
    return { tipo: 'REVISION', motivo: 'VARIOS_COBROS', operaciones };
  return { tipo: 'CONFIRMAR', operacionId: t.operacionId };
}
