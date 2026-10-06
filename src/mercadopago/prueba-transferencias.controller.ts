import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthOrTokenAuthGuard } from 'src/utils/guards/auth-or-token.guard';
import {
  PruebaTransferenciasService,
  VENTANAS_PRUEBA,
  VentanaPrueba,
} from './prueba-transferencias.service';
import { PedirReporteDto } from './dto/prueba-transferencias.dto';

// La prueba de transferencias (ver PruebaTransferenciasService), desde Configuración → MercadoPago
// de la empresa. Ningún handler figura en OPERATOR_ENDPOINTS, así que el operador no entra; el
// servicio deja afuera además al SUPER_ADMIN y exige las condiciones aceptadas. Corre en el
// alcance de la sesión (TenantInterceptor): la cuenta es siempre la de la empresa del usuario,
// nunca una elegida por la URL.
@UseGuards(AuthOrTokenAuthGuard)
@Controller('mercadopago/prueba-transferencias')
export class PruebaTransferenciasController {
  constructor(private readonly prueba: PruebaTransferenciasService) {}

  @Get('pagos')
  pagos(@Req() req: any, @Query('minutos') minutos?: string) {
    usuario(req);
    return this.prueba.ingresos(ventana(minutos));
  }

  @Get('pagos/:operacionId')
  detallePago(@Req() req: any, @Param('operacionId') operacionId: string) {
    usuario(req);
    return this.prueba.detallePago(operacionId);
  }

  @Get('reporte')
  reporte(@Req() req: any) {
    usuario(req);
    return this.prueba.reporte();
  }

  @Post('reporte')
  pedirReporte(@Req() req: any, @Body() dto: PedirReporteDto) {
    usuario(req);
    return this.prueba.pedirReporte(dto.minutos);
  }

  @Post('reporte/configuracion')
  configurarReporte(@Req() req: any) {
    usuario(req);
    return this.prueba.configurarReporte();
  }

  @Get('reporte/archivo')
  leerReporte(@Req() req: any, @Query('nombre') nombre?: string) {
    usuario(req);
    return this.prueba.leerReporte(nombre ?? '');
  }
}

// Una persona identificada, no el token estático del servidor.
function usuario(req: any) {
  if (!req.user?.userId)
    throw new UnauthorizedException(
      'Esta acción requiere un usuario autenticado.',
    );
}

function ventana(minutos?: string): VentanaPrueba {
  const n = Number(minutos ?? 5);
  if (!(VENTANAS_PRUEBA as readonly number[]).includes(n))
    throw new BadRequestException(
      `La ventana tiene que ser de ${VENTANAS_PRUEBA.join(', ')} minutos.`,
    );
  return n as VentanaPrueba;
}
