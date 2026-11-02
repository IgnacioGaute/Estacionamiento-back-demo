import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ConfiguracionInicialService } from './configuracion-inicial.service';
import { AvanzarConfiguracionDto, GuardarPlayaConfiguracionDto } from './dto/configuracion-inicial.dto';

// Los pasos de una playa nueva antes de empezar a trabajar. Sin @UseGuards propio: lo decide
// TenantGuard (global). No figura en OPERATOR_ENDPOINTS, así que es solo para administradores; el
// operador entra directo aunque la playa no haya terminado (sus pantallas ya avisan si faltan tarifas).
@Controller('configuracion-inicial')
export class ConfiguracionInicialController {
  constructor(private readonly configuracion: ConfiguracionInicialService) {}

  @Get()
  estado() {
    return this.configuracion.estado();
  }

  // Nombre y dirección de la playa (pasos 1 y 2). Queda en el historial como una edición de la playa.
  @Patch('playa')
  guardarPlaya(@Body() dto: GuardarPlayaConfiguracionDto) {
    return this.configuracion.guardarPlaya(dto);
  }

  // En qué paso quedó y qué pasos se hicieron u omitieron. No se audita: es el avance del recorrido,
  // no una regla de la playa (cada paso guarda su configuración por su propio camino auditado).
  @Patch('avance')
  avanzar(@Body() dto: AvanzarConfiguracionDto) {
    return this.configuracion.avanzar(dto);
  }
}
