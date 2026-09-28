import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, ValidateNested } from 'class-validator';
import { CreatePlayaDto } from './create-playa.dto';

// Secciones opcionales de la playa. Sólo las prende el super admin (TenancyController).
export class ModulosPlayaDto {
  @IsOptional()
  @IsBoolean()
  inquilinos?: boolean;
}

export class UpdatePlayaDto extends PartialType(CreatePlayaDto) {
  @IsOptional()
  @ValidateNested()
  @Type(() => ModulosPlayaDto)
  modulos?: ModulosPlayaDto;
}
