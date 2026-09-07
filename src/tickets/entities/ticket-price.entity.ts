import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TICKET_DAY_TYPE, TicketDayType } from './ticket.entity';

export const VEHICLE_TYPE = ['AUTO', 'CAMIONETA'] as const;
export type VehicleType = (typeof VEHICLE_TYPE)[number];

export const TICKET_TIME_TYPE = ['DIA', 'SEMANA','SEMANA_Y_DIA'] as const;
export type TicketTimeType = (typeof TICKET_TIME_TYPE)[number];

@Entity({ name: 'tickets-price' })
export class TicketPrice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('int',{nullable:true})
  price: number;

  @Column('enum', { enum: TICKET_DAY_TYPE, nullable:true})
  ticketDayType: TicketDayType;

  @Column('int', {nullable:true})
  ticketTimePrice: number;

  @Column('enum', { enum: VEHICLE_TYPE, nullable:true})
  vehicleType: VehicleType;

  @Column('enum', { enum: TICKET_TIME_TYPE, nullable:true})
  ticketTimeType: TicketTimeType;

  @Column('int', {nullable:true})
  intervalMinutes: number;

}
