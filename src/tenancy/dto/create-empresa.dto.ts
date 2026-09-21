import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
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
}
