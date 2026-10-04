import { PartialType } from '@nestjs/mapped-types';
import { CreateTicketPriceDto } from './create-ticket-price.dto';

export class UpdateTicketPriceDto extends PartialType(CreateTicketPriceDto) {}
