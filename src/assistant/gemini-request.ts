import { HttpException, ServiceUnavailableException } from '@nestjs/common';

/** Consume la respuesta completa dentro del timeout y del bloque de reintentos.
 * Conserva las partes originales, incluidas las firmas de llamadas a herramientas.
 */
export async function requestGemini(
  key: string,
  models: string[],
  body: (model: string) => unknown,
  deadline: number,
  warn: (message: string) => void,
): Promise<{ model: string; parts: any[] }> {
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (deadline - Date.now() < 1000) break;
      let delay = 500 * (attempt + 1);
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body(model)), signal: AbortSignal.timeout(Math.min(12000, deadline - Date.now())),
        });
        if (!response.ok) {
          // No registrar el cuerpo: puede contener datos de la consulta o credenciales.
          warn(`Gemini: modelo=${model} estado=${response.status} intento=${attempt + 1}`);
          const retryAfter = response.headers.get('retry-after');
          if (retryAfter) {
            const seconds = Number(retryAfter);
            delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
          }
          await response.body?.cancel();
          if (response.status === 401 || response.status === 403) throw new HttpException('La clave de Gemini no tiene acceso. Revisá su configuración.', 502);
          if (response.status === 400) throw new HttpException('Gemini rechazó la consulta. Revisá el modelo y su configuración.', 502);
          if (response.status === 404) break; // Probar el modelo de respaldo.
          if (response.status === 429) throw new HttpException('Se alcanzó la cuota de Gemini. Intentá más tarde.', 429);
          if (![500, 502, 503, 504, 408].includes(response.status)) throw new HttpException('Gemini no pudo procesar la consulta.', 502);
        } else {
          const result = await response.json();
          const candidate = result.candidates?.[0];
          const parts = candidate?.content?.parts;
          if (result.promptFeedback?.blockReason || ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT'].includes(candidate?.finishReason)) {
            throw new HttpException('No se pudo responder esa pregunta. Probá reformularla.', 422);
          }
          if (Array.isArray(parts) && parts.some(p => p.functionCall || (typeof p.text === 'string' && p.text.trim() && !p.thought)) && candidate?.finishReason !== 'MAX_TOKENS') return { model, parts };
          warn(`Gemini: respuesta vacía o incompleta modelo=${model}`);
        }
      } catch (error) {
        if (error instanceof HttpException) throw error;
        const failure = error as { name?: string; cause?: { code?: string } };
        const reason = failure?.name === 'TimeoutError' ? 'timeout' : failure?.name === 'SyntaxError' ? 'JSON inválido' : 'conexión/lectura';
        const code = typeof failure?.cause?.code === 'string' && /^[A-Z0-9_]+$/.test(failure.cause.code) ? ` código=${failure.cause.code}` : '';
        warn(`Gemini: respuesta interrumpida modelo=${model} intento=${attempt + 1} motivo=${reason}${code}`);
      }
      if (attempt === 0) {
        delay = Number.isFinite(delay) ? Math.max(0, delay) : 500;
        if (Date.now() + delay + 1000 >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw new ServiceUnavailableException('Los modelos del asistente no respondieron a tiempo. Intentá nuevamente en un momento.');
}
