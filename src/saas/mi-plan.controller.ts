import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { tenantContext } from 'src/tenancy/tenant-context';
import { SuscripcionesService } from './suscripciones.service';
import { CobrosPlataformaService } from './cobros-plataforma.service';
import { ActivarDebitoDto } from './dto/suscripciones.dto';

// El plan de la empresa visto por su administrador: qué tiene cada playa, hasta cuándo pagó, sus
// pagos y cómo pagar (débito automático, MercadoPago o transferencia). No figura en
// OPERATOR_ENDPOINTS (el operador solo ve el aviso del menú) y sí en SUSPENDED_ENDPOINTS: una
// empresa suspendida tiene que poder ver por qué y pagar para volver.
//
// Sin @UseGuards propio: el acceso lo decide TenantGuard (global), que además exige un usuario
// real; el token estático no entra a ninguna ruta operativa.
@Controller('mi-plan')
export class MiPlanController {
  constructor(
    private readonly suscripciones: SuscripcionesService,
    private readonly cobros: CobrosPlataformaService,
    private readonly config: ConfigService,
  ) {}

  private empresa() {
    const scope = tenantContext.getStore();
    if (!scope?.empresaId || !scope.playaId)
      throw new BadRequestException('Elegí una playa para continuar.');
    return scope.empresaId;
  }

  private usuario(req: any): string {
    if (!req.user?.userId)
      throw new UnauthorizedException(
        'Esta acción requiere un usuario autenticado.',
      );
    return req.user.userId;
  }

  /**
   * Pagar y verificar escriben en la cuenta de la empresa, que el rol de la empresa solo puede
   * leer (RLS y grants de solo lectura). Se corren fuera del scope —con el rol de la plataforma—
   * y siempre sobre la empresa de la sesión, que es lo único que llega de afuera.
   */
  private comoPlataforma<T>(fn: () => Promise<T>) {
    return tenantContext.exit(fn);
  }

  @Get()
  async estado() {
    const empresaId = this.empresa();
    return {
      ...(await this.suscripciones.miPlan(empresaId)),
      // Hasta que se cobre automático, el pago es por transferencia: los datos los define el
      // servidor para no tener que publicar una versión nueva del panel cada vez que cambian.
      comoPagar: this.config.get<string>('PLATAFORMA_DATOS_PAGO') || null,
      contacto: this.config.get<string>('PLATAFORMA_WHATSAPP') || null,
      mercadoPago: this.cobros.configurado(),
      // Con la clave pública, el débito se activa con la tarjeta en el panel, sin cuenta de
      // MercadoPago; sin ella, confirmándolo en MercadoPago.
      mercadoPagoClavePublica: this.cobros.clavePublica(),
    };
  }

  // El link de MercadoPago para pagar lo que debe (o el mes que viene).
  @Post('pagar')
  pagarConMercadoPago(@Req() req: any) {
    this.usuario(req);
    const empresaId = this.empresa();
    return this.comoPlataforma(() => this.cobros.pagar(empresaId));
  }

  @Post('debito')
  activarDebito(@Req() req: any, @Body() dto: ActivarDebitoDto) {
    const usuario = this.usuario(req);
    const empresaId = this.empresa();
    return this.comoPlataforma(() =>
      this.cobros.activarDebito(empresaId, dto.email, usuario, dto.tarjeta),
    );
  }

  @Delete('debito')
  async desactivarDebito(@Req() req: any) {
    const usuario = this.usuario(req);
    const empresaId = this.empresa();
    await this.comoPlataforma(() =>
      this.cobros.desactivarDebito(empresaId, usuario),
    );
    return { ok: true };
  }

  // Al volver de MercadoPago: le pregunta por los pagos de esta empresa y asienta los aprobados.
  @Post('verificar')
  verificarPagos(@Req() req: any) {
    this.usuario(req);
    const empresaId = this.empresa();
    return this.comoPlataforma(() => this.cobros.conciliar(empresaId));
  }
}
