import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SuscripcionesService } from './suscripciones.service';

// Los precios que muestra la landing, leídos de la lista de precios de la plataforma. Es una ruta
// pública de solo lectura: TenantGuard la deja pasar sin sesión y el TenantInterceptor no le busca
// empresa. Devuelve solo el catálogo (planes y períodos que se ofrecen), nada de cuentas.
//
// La landing es una exportación estática: la lee al compilarse y, además, el navegador de cada
// visitante la vuelve a pedir desde el dominio de la landing. Por eso esta respuesta (y solo esta)
// se puede leer desde cualquier origen; el resto de la API sigue limitado a ALLOWED_ORIGINS.
@Controller('public/planes')
export class PlanesPublicosController {
  constructor(private readonly suscripciones: SuscripcionesService) {}

  @Get()
  async catalogo(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    // Unos minutos de caché: un cambio de precio se ve enseguida sin pegarle a la base en cada visita.
    res.setHeader('Cache-Control', 'public, max-age=300');
    return this.suscripciones.catalogoPublico();
  }
}
