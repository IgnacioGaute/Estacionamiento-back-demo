import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { DireccionCaja } from './entities/caja-mercadopago.entity';
import {
  DireccionMapa,
  calleYNumero,
  elegirCiudad,
  localidadesDelMapa,
  provinciasPosibles,
} from './ubicacion';

// La dirección de una sucursal de MercadoPago, con red: los listados de provincias y ciudades
// que acepta (los de MercadoLibre) y la dirección de una ubicación (OpenStreetMap). Lo usan la
// caja QR de cada playa (CajasQrService, en la cuenta de la empresa) y la de la plataforma (el QR
// para pagar el plan, en la cuenta de la plataforma). Las reglas sin red están en ubicacion.ts.

const TIEMPO_LIMITE_MS = 12_000;

// MercadoPago valida la provincia y la ciudad de la sucursal contra el listado de ubicaciones de
// MercadoLibre (público, sin token): «Lujan de Cuyo» sin tilde lo rechaza, «Luján de Cuyo» no. Por
// eso se eligen de ese listado. Se guarda un día en memoria: cambia muy de vez en cuando.
const UBICACIONES = 'https://api.mercadolibre.com/classified_locations';
const UN_DIA_MS = 24 * 60 * 60 * 1000;
// El listado de Argentina incluye zonas de otros países para avisos clasificados: no son provincias.
const NO_SON_PROVINCIAS = new Set([
  'Brasil',
  'Chile',
  'República Dominicana',
  'USA',
  'Uruguay',
]);
const ubicaciones = new Map<
  string,
  { hasta: number; lista: { id: string; nombre: string }[] }
>();
const alfabetico = (a: { nombre: string }, b: { nombre: string }) =>
  a.nombre.localeCompare(b.nombre, 'es');

/** Para las pruebas: descarta el listado de ubicaciones guardado. */
export const olvidarUbicaciones = () => ubicaciones.clear();

async function ubicacion(
  clave: string,
  url: string,
  leer: (datos: any) => { id: string; nombre: string }[],
) {
  const guardada = ubicaciones.get(clave);
  if (guardada && guardada.hasta > Date.now()) return guardada.lista;
  let datos: any;
  try {
    const respuesta = await fetch(url, {
      signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
    });
    if (!respuesta.ok) throw new Error(String(respuesta.status));
    datos = await respuesta.json();
  } catch {
    throw new ServiceUnavailableException(
      'No se pudo cargar el listado de localidades de MercadoPago. Probá de nuevo en un momento.',
    );
  }
  const lista = leer(datos).sort(alfabetico);
  ubicaciones.set(clave, { hasta: Date.now() + UN_DIA_MS, lista });
  return lista;
}

/** Las provincias que acepta MercadoPago para una sucursal. */
export function provinciasMp() {
  return ubicacion('AR', `${UBICACIONES}/countries/AR`, (datos) =>
    ((datos?.states ?? []) as any[])
      .filter((s) => !NO_SON_PROVINCIAS.has(s?.name))
      .map((s) => ({ id: String(s.id), nombre: String(s.name) })),
  );
}

/** Las ciudades de una provincia, tal como las escribe MercadoPago (con tildes). */
export function ciudadesMp(provinciaId: string) {
  if (!/^[A-Za-z0-9=_-]{2,80}$/.test(provinciaId))
    throw new BadRequestException('Provincia inválida.');
  return ubicacion(
    provinciaId,
    `${UBICACIONES}/states/${provinciaId}`,
    (datos) =>
      ((datos?.cities ?? []) as any[]).map((c) => ({
        id: String(c.id),
        nombre: String(c.name),
      })),
  );
}

/**
 * Antes de pedirle nada a MercadoPago: la provincia y la ciudad tienen que estar escritas como
 * en su listado, si no rechaza la sucursal («city_name was invalid»).
 */
export async function validarDireccionMp(direccion: DireccionCaja) {
  const provincia = (await provinciasMp()).find(
    (p) => p.nombre === direccion.provincia,
  );
  if (!provincia)
    throw new BadRequestException(
      'Elegí la provincia de la lista: MercadoPago solo acepta las de su listado.',
    );
  const ciudad = (await ciudadesMp(provincia.id)).find(
    (c) => c.nombre === direccion.ciudad,
  );
  if (!ciudad)
    throw new BadRequestException(
      'Elegí la ciudad de la lista: MercadoPago solo acepta las de su listado, escritas como ahí (con tildes).',
    );
}

// OpenStreetMap (Nominatim), con un nombre que identifica al sistema como pide su política de
// uso. Se llama una vez por caja creada.
async function direccionDelMapa(
  latitud: number,
  longitud: number,
): Promise<DireccionMapa> {
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.search = new URLSearchParams({
    format: 'jsonv2',
    lat: String(latitud),
    lon: String(longitud),
    zoom: '18',
    addressdetails: '1',
    'accept-language': 'es',
  }).toString();
  try {
    const respuesta = await fetch(url, {
      headers: {
        'user-agent': 'estacionamiento-sistema/1.0 (cajas de MercadoPago)',
      },
      signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
    });
    if (!respuesta.ok) throw new Error(String(respuesta.status));
    const datos = (await respuesta.json()) as { address?: DireccionMapa };
    return datos.address ?? {};
  } catch {
    throw new ServiceUnavailableException(
      'No se pudo reconocer la dirección de la ubicación. Probá de nuevo o completala a mano.',
    );
  }
}

// Sin `direccion` (no se reconoció la localidad) vienen `motivo` y `sugerencia` para completar a mano.
export type DireccionDeUbicacion = {
  direccion: DireccionCaja | null;
  motivo?: string;
  sugerencia?: {
    calle: string;
    numero: string;
    provincia: string | null;
    latitud: number;
    longitud: number;
  };
};

/**
 * De la ubicación del dispositivo a la dirección de la sucursal: el mapa da provincia y localidad,
 * que se ajustan al listado de MercadoPago; calle y número salen de `direccionConocida` (la que
 * ya tiene el sistema) o del mapa. Si la localidad no se reconoce no se adivina: vuelve lo
 * detectado para completar a mano.
 */
export async function direccionDeUbicacion(
  latitud: number,
  longitud: number,
  direccionConocida: string | null | undefined,
  fueraDeArgentina: string,
): Promise<DireccionDeUbicacion> {
  const mapa = await direccionDelMapa(latitud, longitud);
  if (mapa.country_code && mapa.country_code !== 'ar')
    throw new BadRequestException(fueraDeArgentina);
  const { calle, numero } = calleYNumero(mapa, direccionConocida);
  const posibles = provinciasPosibles(mapa.state, await provinciasMp());
  for (const provincia of posibles) {
    const ciudad = elegirCiudad(
      localidadesDelMapa(mapa),
      await ciudadesMp(provincia.id),
    );
    if (ciudad)
      return {
        direccion: {
          calle,
          numero,
          ciudad: ciudad.nombre,
          provincia: provincia.nombre,
          latitud,
          longitud,
          referencia: mapa.suburb || mapa.neighbourhood || null,
        },
      };
  }
  return {
    direccion: null,
    motivo:
      'No pudimos reconocer la localidad con la ubicación. Elegila de la lista y creá la caja.',
    sugerencia: {
      calle,
      numero,
      provincia: posibles[0]?.nombre ?? null,
      latitud,
      longitud,
    },
  };
}
