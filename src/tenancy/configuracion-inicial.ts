import { BadRequestException } from '@nestjs/common';

// La configuración inicial de una playa nueva: los pasos que su administrador recorre al entrar
// por primera vez. Los datos de cada paso se guardan en su lugar de siempre (la playa, los tipos
// de vehículo, las tarifas, los pases, los turnos, MercadoPago, los usuarios); acá solo queda el avance, para
// retomar donde quedó y saber cuándo dejar de mostrarla.
export const PASOS_CONFIGURACION = ['nombre', 'ubicacion', 'vehiculos', 'tarifas', 'pases', 'turnos', 'mercadopago', 'usuarios'] as const;
export type PasoConfiguracion = (typeof PASOS_CONFIGURACION)[number];
// Los pases (día, semana, mes), turnos, MercadoPago y usuarios se pueden dejar para después; el
// resto hace falta para operar.
export const PASOS_OMITIBLES: readonly PasoConfiguracion[] = ['pases', 'turnos', 'mercadopago', 'usuarios'];
export const PASOS_OBLIGATORIOS = PASOS_CONFIGURACION.filter((paso) => !PASOS_OMITIBLES.includes(paso));

// Una playa sin `terminadaEn` todavía no terminó su configuración. Las que ya existían cuando
// apareció este recorrido se marcaron terminadas en la migración ConfiguracionInicial.
export type ConfiguracionInicial = {
  paso?: PasoConfiguracion;
  hechos?: PasoConfiguracion[];
  omitidos?: PasoConfiguracion[];
  terminadaEn?: string;
};

export type AvanceConfiguracion = {
  paso?: PasoConfiguracion;
  hecho?: PasoConfiguracion;
  omitido?: PasoConfiguracion;
  terminar?: boolean;
};

const sinRepetir = (pasos: PasoConfiguracion[]) => PASOS_CONFIGURACION.filter((paso) => pasos.includes(paso));

/** El avance nuevo a partir del guardado. Un paso hecho deja de figurar como omitido y viceversa. */
export function aplicarAvance(actual: ConfiguracionInicial | null | undefined, cambio: AvanceConfiguracion, ahora: Date): ConfiguracionInicial {
  const siguiente: ConfiguracionInicial = { ...(actual ?? {}) };
  let hechos = [...(actual?.hechos ?? [])];
  let omitidos = [...(actual?.omitidos ?? [])];
  if (cambio.omitido && !PASOS_OMITIBLES.includes(cambio.omitido))
    throw new BadRequestException({ code: 'PASO_OBLIGATORIO', message: 'Este paso hace falta para empezar a trabajar: no se puede omitir.' });
  if (cambio.hecho) {
    hechos.push(cambio.hecho);
    omitidos = omitidos.filter((paso) => paso !== cambio.hecho);
  }
  if (cambio.omitido) {
    omitidos.push(cambio.omitido);
    hechos = hechos.filter((paso) => paso !== cambio.omitido);
  }
  siguiente.hechos = sinRepetir(hechos);
  siguiente.omitidos = sinRepetir(omitidos);
  if (cambio.paso) siguiente.paso = cambio.paso;
  if (cambio.terminar) {
    const faltan = PASOS_OBLIGATORIOS.filter((paso) => !siguiente.hechos!.includes(paso));
    if (faltan.length)
      throw new BadRequestException({ code: 'CONFIGURACION_INCOMPLETA', message: 'Faltan pasos para terminar la configuración.', faltan });
    // Terminar es una sola vez: volver a pedirlo no cambia la fecha.
    siguiente.terminadaEn ??= ahora.toISOString();
  }
  return siguiente;
}
