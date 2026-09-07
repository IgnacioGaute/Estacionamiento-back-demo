import {
  Column,
  Entity,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TicketRegistration } from './ticket-registration.entity';
import { TicketPrice } from './ticket-price.entity';

export const TICKET_TYPE = ['AUTO', 'CAMIONETA'] as const;
export type TicketType = (typeof TICKET_TYPE)[number];

export const TICKET_DAY_TYPE= ['DAY', 'NIGHT'] as const;
export type TicketDayType = (typeof TICKET_DAY_TYPE)[number];

@Entity({ name: 'tickets' })
export class Ticket {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  
  @Column('varchar', { length: 255 })
  codeBar: string;

  @Column('int', {nullable:true})
  price: number;

  @Column('enum', { enum: TICKET_DAY_TYPE, nullable:true})
  ticketDayType: string;

  @Column('enum', { enum: TICKET_TYPE})
  vehicleType: string;

  @Column('int', {nullable:true})
  intervalMinutes: number;

  @OneToOne(() => TicketRegistration, (ticketRegistration) => ticketRegistration.ticket)
  ticketRegistration: TicketRegistration;
}
