import {
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { CobrosPlataformaService } from './cobros-plataforma.service';
import { MercadoPagoPlataforma } from './mercadopago-plataforma';

// Donde MercadoPago avisa que pasó algo con un pago o un débito automático de la plataforma.
// Es una ruta pública (MercadoPago no inicia sesión): TenantGuard la deja pasar sin usuario y el
// TenantInterceptor no le busca empresa. Por eso no se le cree nada: se valida la firma cuando hay
// clave configurada y lo único que se usa es el id, para preguntarle a MercadoPago con el token
// propio. Si algo falla, la revisión periódica lo vuelve a intentar.
@Controller('mercadopago/plataforma')
export class AvisoMercadoPagoController {
  private readonly logger = new Logger(AvisoMercadoPagoController.name);

  constructor(
    private readonly cobros: CobrosPlataformaService,
    private readonly mp: MercadoPagoPlataforma,
  ) {}

  @Post('aviso')
  @HttpCode(200)
  async aviso(@Req() req: any) {
    const query = req.query ?? {};
    const cuerpo = req.body ?? {};
    const tipo = String(
      query.type ?? query.topic ?? cuerpo.type ?? cuerpo.topic ?? '',
    );
    const id = String(query['data.id'] ?? cuerpo?.data?.id ?? query.id ?? '');
    if (!/^[\w-]{1,64}$/.test(id) || !/^[a-z_]{1,64}$/.test(tipo))
      return { ok: true };
    if (
      !this.mp.firmaValida({
        firma: req.headers['x-signature'],
        requestId: req.headers['x-request-id'],
        dataId: id,
      })
    )
      throw new UnauthorizedException();
    try {
      await this.cobros.procesarAviso(tipo, id);
    } catch (error) {
      // Se responde 200 igual: reintentar el aviso no arregla un error nuestro, y la revisión
      // periódica vuelve a preguntar por ese pago.
      this.logger.error(
        `No se pudo procesar el aviso ${tipo} ${id}: ${error instanceof Error ? error.message : error}`,
      );
    }
    return { ok: true };
  }
}
