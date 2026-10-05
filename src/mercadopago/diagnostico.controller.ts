import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SuperAdminGuard } from 'src/utils/guards/super-admin.guard';
import {
  PruebaTransferenciasService,
  VENTANAS_PRUEBA,
  VentanaPrueba,
} from './prueba-transferencias.service';
import { PedirReporteDto } from './dto/prueba-transferencias.dto';

// La prueba de transferencias (ver PruebaTransferenciasService): solo el super admin, y el servicio
// además solo la corre sobre cuentas de MercadoPago autorizadas para probar. No forma parte de la
// operación ni es la función comercial.
//
// Corre fuera del TenantInterceptor (está en su lista, como TenancyController): la empresa la
// elige el super admin por la URL, no sale de su sesión.
@Controller('tenancy/empresas/:empresaId/mercadopago/prueba-transferencias')
@UseGuards(SuperAdminGuard)
export class DiagnosticoMercadoPagoController {
  constructor(private readonly prueba: PruebaTransferenciasService) {}

  @Get('pagos')
  pagos(
    @Param('empresaId', ParseUUIDPipe) empresaId: string,
    @Query('minutos') minutos?: string,
  ) {
    return this.prueba.ingresos(empresaId, ventana(minutos));
  }

  @Get('reporte')
  reporte(@Param('empresaId', ParseUUIDPipe) empresaId: string) {
    return this.prueba.reporte(empresaId);
  }

  @Post('reporte')
  pedirReporte(
    @Param('empresaId', ParseUUIDPipe) empresaId: string,
    @Body() dto: PedirReporteDto,
  ) {
    return this.prueba.pedirReporte(empresaId, dto.minutos);
  }

  @Post('reporte/configuracion')
  configurarReporte(@Param('empresaId', ParseUUIDPipe) empresaId: string) {
    return this.prueba.configurarReporte(empresaId);
  }

  @Get('reporte/archivo')
  leerReporte(
    @Param('empresaId', ParseUUIDPipe) empresaId: string,
    @Query('nombre') nombre?: string,
  ) {
    return this.prueba.leerReporte(empresaId, nombre ?? '');
  }
}

function ventana(minutos?: string): VentanaPrueba {
  const n = Number(minutos ?? 5);
  if (!(VENTANAS_PRUEBA as readonly number[]).includes(n))
    throw new BadRequestException(
      `La ventana tiene que ser de ${VENTANAS_PRUEBA.join(', ')} minutos.`,
    );
  return n as VentanaPrueba;
}
