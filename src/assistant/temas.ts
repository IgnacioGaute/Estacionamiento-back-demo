// El tema de una pregunta al asistente, para que el panel de plataforma muestre de qué se
// consulta sin leer una por una. Se decide por palabras clave y, si ninguna aparece, por la
// herramienta que el modelo tuvo que usar para responder.
//
// El orden importa: «¿el QR de MercadoPago no anda?» tiene que caer en MercadoPago y no en
// comprobantes, «cierre de caja» en caja antes que en cobros y «¿cuánto sale la hora?» en
// tarifas antes que en cobros.

export const TEMAS = [
  'mercadopago',
  'caja',
  'comprobantes',
  'abonos',
  'tarifas',
  'cobros',
  'vehiculos',
  'sistema',
  'otros',
] as const;
export type Tema = (typeof TEMAS)[number];

const PALABRAS: [Exclude<Tema, 'otros'>, RegExp][] = [
  ['mercadopago', /mercado ?pago|\bmp\b|qr de pago|cobrar con qr|pagar con qr/],
  ['caja', /\bcaja\b|turno|arqueo|efectivo|apertura|cierre de caja|fondo inicial|retiro|relevo/],
  ['comprobantes', /comprobante|recibo|whatsapp|imprim|impresora|ticket impreso|\bqr\b|papel/],
  ['abonos', /abono|mensual|por mes|por semana|por dia|semanal|estadia larga|dia\/sem/],
  ['tarifas', /tarifa|precio|franja|cuanto (sale|cuesta|vale)|cuesta|tolerancia|nocturn|recargo|la hora|por hora|hora extra/],
  ['cobros', /cobr|pag[oa]|vuelto|saldo|importe|cuanto (debe|es)|descuento|cortesia|devol/],
  ['vehiculos', /patente|vehiculo|auto\b|autos\b|camioneta|moto|entrada|salida|ingres|egres|adentro|activo/],
  ['sistema', /contrasena|usuario|acceso|sesion|no anda|no funciona|error|sin conexion|offline|instalar|app\b/],
];

const POR_HERRAMIENTA: Record<string, Exclude<Tema, 'otros'>> = {
  current_cash: 'caja',
  shift_history: 'caja',
  pricing_settings: 'tarifas',
  ticket_amount: 'cobros',
  active_vehicles: 'vehiculos',
};

// Minúsculas, sin tildes ni signos: «¿Cuánto sale?» y «cuanto sale» son la misma pregunta.
export function claveDePregunta(texto: string) {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function temaDePregunta(texto: string, consultadas: string[] = []): Tema {
  const clave = claveDePregunta(texto);
  for (const [tema, patron] of PALABRAS) if (patron.test(clave)) return tema;
  for (const herramienta of consultadas)
    if (POR_HERRAMIENTA[herramienta]) return POR_HERRAMIENTA[herramienta];
  return 'otros';
}
