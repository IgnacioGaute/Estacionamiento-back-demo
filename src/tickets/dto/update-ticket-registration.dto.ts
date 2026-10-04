import { PartialType } from '@nestjs/mapped-types';
import { CreateTicketRegistrationDto } from './create-ticket-registration.dto';

export class UpdateTicketRegistrationDto extends PartialType(CreateTicketRegistrationDto) {}
