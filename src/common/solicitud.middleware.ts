import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

const logger = new Logger('Solicitud');

// Solo identificadores simples: el valor vuelve en un encabezado y en los logs.
const ID_VALIDO = /^[A-Za-z0-9._-]{8,80}$/;

// Ids, tokens de comprobantes y números largos se reemplazan para que el log diga la ruta y no
// datos de una estadía, una patente o un enlace público.
export function rutaSanitizada(url: string) {
  return (url.split('?')[0] || '/')
    .split('/')
    .map((parte) =>
      /^[0-9a-f-]{20,}$/i.test(parte) || /^\d{3,}$/.test(parte) || parte.length > 40
        ? ':id'
        : /^[A-Z]{3}\d{3}$|^[A-Z]{2}\d{3}[A-Z]{2}$/i.test(parte)
          ? ':patente'
          : parte,
    )
    .join('/');
}

/**
 * Correlación con el frontend: usa el X-Request-Id que manda el servidor del front (o crea uno),
 * lo devuelve en la respuesta y registra en una línea las respuestas 5xx con ruta sanitizada,
 * estado y duración. Nunca registra encabezados, cuerpos ni la consulta (pueden tener tokens o
 * datos personales). Los rechazos 4xx son parte del funcionamiento normal y no se registran acá.
 */
export function solicitudMiddleware(req: Request, res: Response, next: NextFunction) {
  const recibido = req.headers['x-request-id'];
  const id = typeof recibido === 'string' && ID_VALIDO.test(recibido) ? recibido : randomUUID();
  res.setHeader('X-Request-Id', id);
  const inicio = Date.now();
  res.on('finish', () => {
    if (res.statusCode < 500) return;
    logger.warn(
      JSON.stringify({
        requestId: id,
        metodo: req.method,
        ruta: rutaSanitizada(req.originalUrl ?? req.url),
        estado: res.statusCode,
        ms: Date.now() - inicio,
      }),
    );
  });
  next();
}
