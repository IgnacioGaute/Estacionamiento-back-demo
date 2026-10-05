import { Module } from '@nestjs/common';
import { PlateRecognizerCuentasService } from './plate-recognizer-cuentas.service';

// Las cuentas de Plate Recognizer por playa, sin el controller de escaneo: TenancyModule las
// administra desde la ficha de la empresa y no tiene por qué levantar las rutas del operador.
@Module({
  providers: [PlateRecognizerCuentasService],
  exports: [PlateRecognizerCuentasService],
})
export class PlateRecognizerCuentasModule {}
