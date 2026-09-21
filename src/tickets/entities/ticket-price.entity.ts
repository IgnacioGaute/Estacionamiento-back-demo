import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Playa } from 'src/tenancy/entities/playa.entity';
import { TICKET_DAY_TYPE, TicketDayType, VEHICLE_TYPE, VehicleType, TICKET_TIME_TYPE, TicketTimeType } from './ticket.constants';
export { VEHICLE_TYPE, VehicleType, TICKET_TIME_TYPE, TicketTimeType } from './ticket.constants';

@Entity({ name: 'tickets-price' })
export class TicketPrice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid', { nullable: true })
  playaId: string | null;

  @ManyToOne(() => Playa, { nullable: true })
  @JoinColumn({ name: 'playaId' })
  playa: Playa | null;

  @Column('int',{nullable:true})
  price: number;

  @Column('enum', { enum: TICKET_DAY_TYPE, nullable:true})
  ticketDayType: TicketDayType;

  @Column('int', {nullable:true})
  ticketTimePrice: number;

  @Column('varchar', { length: 32, nullable: true })
  vehicleType: VehicleType;

  @Column('enum', { enum: TICKET_TIME_TYPE, nullable:true})
  ticketTimeType: TicketTimeType;

  @Column('int', {nullable:true})
  intervalMinutes: number;

}
