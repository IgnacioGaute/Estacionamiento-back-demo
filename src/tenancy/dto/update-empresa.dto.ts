import { OmitType, PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CreateEmpresaDto } from './create-empresa.dto';

// La prueba gratis se da al crear o desde la solapa Plan, no editando la empresa.
export class UpdateEmpresaDto extends PartialType(OmitType(CreateEmpresaDto, ['diasPrueba'] as const)) {
  // Por qué se suspende o reactiva a mano. No es un dato de la empresa: queda en la auditoría,
  // junto al cambio de estado, para que la actividad explique el corte.
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsOptional()
  @IsString()
  @MaxLength(255)
  motivo?: string;
}
