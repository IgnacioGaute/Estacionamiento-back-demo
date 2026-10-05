import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SuperAdminGuard } from 'src/utils/guards/super-admin.guard';
import { MercadoPagoService } from './mercadopago.service';

// Diagnóstico de la cuenta de MercadoPago conectada de una empresa, solo para el super admin: lo
// que MercadoPago informa que entró en los últimos días. Es una prueba para saber si los pagos al
// alias de una playa se pueden ver desde el sistema; no forma parte de la operación.
//
// Corre fuera del TenantInterceptor (está en su lista, como TenancyController): la empresa la
// elige el super admin por la URL, no sale de su sesión.
@Controller('tenancy/empresas/:empresaId/mercadopago')
@UseGuards(SuperAdminGuard)
export class DiagnosticoMercadoPagoController {
  constructor(private readonly mercadoPago: MercadoPagoService) {}

  @Get('ingresos')
  ingresos(
    @Param('empresaId', ParseUUIDPipe) empresaId: string,
    @Query('dias') dias?: string,
  ) {
    const n = Math.trunc(Number(dias ?? 2));
    return this.mercadoPago.diagnosticoIngresos(
      empresaId,
      Number.isFinite(n) ? Math.min(Math.max(n, 1), 30) : 2,
    );
  }
}
