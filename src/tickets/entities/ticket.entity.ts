import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Playa } from 'src/tenancy/entities/playa.entity';
import { TicketRegistration } from './ticket-registration.entity';
import { TicketPrice } from './ticket-price.entity';

import { TICKET_TYPE, TICKET_DAY_TYPE } from './ticket.constants';
export { TICKET_TYPE, TICKET_DAY_TYPE, TicketType, TicketDayType } from './ticket.constants';

// Las tarjetas son físicas y de una playa: el mismo código puede existir en dos playas.
@Index(['playaId', 'codeBar'], { unique: true })
@Entity({ name: 'tickets' })
export class Ticket {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid', { nullable: true })
  playaId: string | null;

  @ManyToOne(() => Playa, { nullable: true })
  @JoinColumn({ name: 'playaId' })
  playa: Playa | null;
  
  @Column('varchar', { length: 255 })
  codeBar: string;

  @Column('int', {nullable:true})
  price: number;

  @Column('enum', { enum: TICKET_DAY_TYPE, nullable:true})
  ticketDayType: string;

  @Column('varchar', { length: 32 })
  vehicleType: string;

  @Column('int', {nullable:true})
  intervalMinutes: number;

  @OneToOne(() => TicketRegistration, (ticketRegistration) => ticketRegistration.ticket)
  ticketRegistration: TicketRegistration;
}
