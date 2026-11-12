import { Controller, Get, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { DataSource } from 'typeorm';

// La versión de este despliegue. Railway la expone en cada servicio; en local no existe.
export const VERSION_API =
  process.env.RAILWAY_GIT_COMMIT_SHA || process.env.RAILWAY_DEPLOYMENT_ID || 'dev';

// Disponibilidad para el healthcheck de Railway y las pruebas de humo después de desplegar: que el
// proceso arrancó (las migraciones corren antes de escuchar) y que la base responde. Es pública y
// no devuelve datos de nadie: TenantGuard la deja pasar sin sesión y TenantInterceptor no busca
// empresa. Un despliegue «exitoso» no prueba los flujos; esto solo dice que el servidor está listo.
@Controller('salud')
export class SaludController {
  constructor(private readonly ds: DataSource) {}

  @Get()
  async estado(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await this.ds.query('SELECT 1');
    } catch {
      // Sin detalle: el error de conexión puede incluir host o usuario de la base.
      throw new ServiceUnavailableException({
        code: 'BASE_NO_DISPONIBLE',
        message: 'La base de datos no responde.',
      });
    }
    return { estado: 'listo', version: VERSION_API };
  }
}
