import {
  calleYNumero,
  elegirCiudad,
  localidadesDelMapa,
  provinciasPosibles,
} from './ubicacion';

const PROVINCIAS = [
  { id: 'BA', nombre: 'Buenos Aires' },
  { id: 'GBAN', nombre: 'Bs.As. G.B.A. Norte' },
  { id: 'BAI', nombre: 'Buenos Aires Interior' },
  { id: 'CF', nombre: 'Capital Federal' },
  { id: 'MZA', nombre: 'Mendoza' },
  { id: 'CBA', nombre: 'Córdoba' },
];

describe('De la ubicación a la dirección que acepta MercadoPago', () => {
  test('la provincia del mapa se busca en el listado, sin tildes', () => {
    expect(provinciasPosibles('Mendoza', PROVINCIAS)).toEqual([
      { id: 'MZA', nombre: 'Mendoza' },
    ]);
    expect(provinciasPosibles('Cordoba', PROVINCIAS)).toEqual([
      { id: 'CBA', nombre: 'Córdoba' },
    ]);
    expect(provinciasPosibles(undefined, PROVINCIAS)).toEqual([]);
  });

  test('CABA es Capital Federal y la provincia de Buenos Aires prueba todas sus zonas', () => {
    expect(
      provinciasPosibles('Ciudad Autónoma de Buenos Aires', PROVINCIAS).map(
        (p) => p.id,
      ),
    ).toEqual(['CF']);
    expect(
      provinciasPosibles('Buenos Aires', PROVINCIAS).map((p) => p.id),
    ).toEqual(['BA', 'GBAN', 'BAI']);
  });

  test('«Departamento Luján de Cuyo» del mapa es «Luján de Cuyo» del listado (la prueba real)', () => {
    const mapa = {
      suburb: 'Distrito Carrodilla',
      county: 'Departamento Luján de Cuyo',
      state: 'Mendoza',
    };
    const ciudades = [
      { id: 'G', nombre: 'Godoy Cruz' },
      { id: 'L', nombre: 'Luján de Cuyo' },
    ];
    expect(elegirCiudad(localidadesDelMapa(mapa), ciudades)).toEqual({
      id: 'L',
      nombre: 'Luján de Cuyo',
    });
    expect(
      elegirCiudad(['Partido de Escobar'], [{ id: 'E', nombre: 'Escobar' }])
        ?.id,
    ).toBe('E');
    expect(elegirCiudad(['Rosario'], ciudades)).toBeNull();
  });

  test('calle y número: primero la dirección de la playa, después el mapa, si no S/N', () => {
    expect(calleYNumero({ road: 'Otra' }, 'Malabia 705')).toEqual({
      calle: 'Malabia',
      numero: '705',
    });
    expect(calleYNumero({}, 'Av. San Martín, 1234')).toEqual({
      calle: 'Av. San Martín',
      numero: '1234',
    });
    expect(
      calleYNumero({ road: 'Malabia', house_number: '705' }, null),
    ).toEqual({ calle: 'Malabia', numero: '705' });
    expect(calleYNumero({ road: 'Malabia' }, '')).toEqual({
      calle: 'Malabia',
      numero: 'S/N',
    });
    expect(calleYNumero({ suburb: 'Distrito Carrodilla' }, null)).toEqual({
      calle: 'Distrito Carrodilla',
      numero: 'S/N',
    });
  });
});
