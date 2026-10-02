import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { EMPRESA_ESTADO, EmpresaEstado } from '../entities/empresa.entity';

export class CreateEmpresaDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  nombre: string;

  @IsIn(EMPRESA_ESTADO)
  @IsOptional()
  estado?: EmpresaEstado;

  // Días de prueba gratis desde hoy. Es una opción del alta: sin esto (o con 0) la empresa queda
  // sin plan ni vencimiento, y la prueba se le puede dar después desde su ficha.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  diasPrueba?: number;
}
