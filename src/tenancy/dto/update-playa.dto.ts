import { PartialType } from '@nestjs/mapped-types';
import { CreatePlayaDto } from './create-playa.dto';

export class UpdatePlayaDto extends PartialType(CreatePlayaDto) {}
