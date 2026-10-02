import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateEmpresaDto } from './create-empresa.dto';

// La prueba gratis se da al crear o desde la solapa Plan, no editando la empresa.
export class UpdateEmpresaDto extends PartialType(OmitType(CreateEmpresaDto, ['diasPrueba'] as const)) {}
