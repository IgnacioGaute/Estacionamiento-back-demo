import { PartialType } from '@nestjs/mapped-types';
import { CreateTicketPriceBracketDto } from './create-ticket-price-bracket.dto';

export class UpdateTicketPriceBracketDto extends PartialType(CreateTicketPriceBracketDto) {}
