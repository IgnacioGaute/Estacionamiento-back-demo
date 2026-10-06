// El reconocimiento gratuito: fast-alpr (licencia MIT) corriendo en un servicio propio (carpeta
// `alpr/` de este repo, otro servicio en Railway). Lo usan las playas sin plan de Plate Recognizer.
// Sin ALPR_URL y ALPR_TOKEN no hay modo gratuito y esas playas no muestran la cámara.
export function alprConfigurado(): { url: string; token: string } | null {
  const url = process.env.ALPR_URL?.trim();
  const token = process.env.ALPR_TOKEN?.trim();
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}
