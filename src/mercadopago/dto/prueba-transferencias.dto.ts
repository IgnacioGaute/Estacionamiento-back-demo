import { IsIn } from 'class-validator';
import {
  VENTANAS_PRUEBA,
  VentanaPrueba,
} from '../prueba-transferencias.service';

// Pedir un reporte de prueba: solo la ventana, de una lista fija (no un rango libre de fechas).
export class PedirReporteDto {
  @IsIn(VENTANAS_PRUEBA)
  minutos: VentanaPrueba;
}
