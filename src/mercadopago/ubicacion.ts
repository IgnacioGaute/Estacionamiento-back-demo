// De una ubicación (latitud y longitud) a la dirección que MercadoPago acepta para la sucursal de
// una caja. MercadoPago valida provincia y ciudad contra el listado de MercadoLibre, escritas como
// ahí («Luján de Cuyo», con tilde); la dirección que da el mapa (OpenStreetMap) las escribe a su
// manera («Departamento Luján de Cuyo»). Estas funciones hacen el puente, sin red, para poder
// probarlas (ubicacion.spec.ts).

export interface Ubicacion {
  id: string;
  nombre: string;
}

// Lo que devuelve OpenStreetMap en `address` (solo lo que se usa).
export interface DireccionMapa {
  road?: string;
  house_number?: string;
  neighbourhood?: string;
  suburb?: string;
  city_district?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
  state_district?: string;
  state?: string;
  country_code?: string;
}

export const normalizar = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// «Departamento Luján de Cuyo», «Partido de Escobar», «Distrito Carrodilla» → la localidad.
const PREFIJO =
  /^(departamento|partido|municipio|municipalidad|ciudad|distrito|comuna|localidad|pedania) (de |del )?/;
const localidad = (s: string) => normalizar(s).replace(PREFIJO, '').trim();

/**
 * Las provincias del listado que corresponden a la del mapa. La de Buenos Aires está partida en
 * varias zonas (GBA Norte, Oeste, Sur, Interior, Costa Atlántica): se prueban todas.
 */
export function provinciasPosibles(
  estado: string | undefined,
  provincias: Ubicacion[],
): Ubicacion[] {
  if (!estado) return [];
  const n = normalizar(estado);
  if (n.includes('ciudad autonoma') || n === 'capital federal' || n === 'caba')
    return provincias.filter((p) => normalizar(p.nombre) === 'capital federal');
  if (n.includes('buenos aires'))
    return provincias
      .filter((p) => {
        const m = normalizar(p.nombre);
        return (
          m !== 'capital federal' &&
          (m.includes('buenos aires') || m.startsWith('bs as'))
        );
      })
      .sort((a, b) =>
        normalizar(a.nombre) === 'buenos aires'
          ? -1
          : normalizar(b.nombre) === 'buenos aires'
            ? 1
            : 0,
      );
  return provincias.filter((p) => normalizar(p.nombre) === n);
}

/** Los nombres de localidad que trae el mapa, del más preciso al más general. */
export function localidadesDelMapa(d: DireccionMapa): string[] {
  return [
    d.city,
    d.town,
    d.village,
    d.municipality,
    d.county,
    d.city_district,
    d.suburb,
    d.state_district,
  ].filter((v): v is string => !!v && !!v.trim());
}

/** La ciudad del listado que coincide con alguna localidad del mapa (sin tildes ni prefijos). */
export function elegirCiudad(
  candidatas: string[],
  ciudades: Ubicacion[],
): Ubicacion | null {
  for (const candidata of candidatas) {
    const buscada = localidad(candidata);
    const encontrada = ciudades.find((c) => localidad(c.nombre) === buscada);
    if (encontrada) return encontrada;
  }
  return null;
}

/**
 * Calle y número para la sucursal. Manda la dirección que la playa ya tiene en el sistema (la
 * cargó una persona); si no tiene, la del mapa; sin ninguna, el barrio y «S/N».
 */
export function calleYNumero(
  d: DireccionMapa,
  direccionPlaya?: string | null,
): { calle: string; numero: string } {
  const propia = direccionPlaya?.trim();
  const conNumero = propia?.match(/^(.*?\D)[\s,]*(\d{1,6})\b/);
  if (conNumero?.[1]?.trim())
    return {
      calle: conNumero[1].replace(/[\s,]+$/, '').trim(),
      numero: conNumero[2],
    };
  if (d.road) return { calle: d.road, numero: d.house_number?.trim() || 'S/N' };
  if (propia) return { calle: propia.slice(0, 80), numero: 'S/N' };
  return {
    calle: d.neighbourhood || d.suburb || d.city_district || 'Sin calle',
    numero: 'S/N',
  };
}
