import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Playa } from 'src/tenancy/entities/playa.entity';
import { BoxList } from 'src/box-lists/entities/box-list.entity';
import { TICKET_TIME_TYPE, TicketTimeType } from './ticket.constants';
import { TICKET_TYPE } from './ticket.constants';

@Entity({ name: 'ticket_registration_for_days' })
export class TicketRegistrationForDay {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid', { nullable: true })
  playaId: string | null;

  @ManyToOne(() => Playa, { nullable: true })
  @JoinColumn({ name: 'playaId' })
  playa: Playa | null;
  
  @Column('varchar', { length: 255 })
  description: string;

  @Column('int')
  price: number;

  @Column('int', {nullable:true})
  weeks: number;

  @Column('int', {nullable:true})
  days: number;

  @Column('int', { nullable: true })
  months: number;

  @Column('date', { nullable: true })
  dateNow: string | null;

  @Column('enum', { enum: TICKET_TIME_TYPE, nullable:true})
  ticketTimeType: TicketTimeType;

  @Column('varchar', { length: 100, nullable:true })
  firstNameCustomer: string;

  @Column('varchar', { length: 100, nullable:true  })
  lastNameCustomer: string;

  @Column('varchar', { length: 50, nullable:true  })
  vehiclePlateCustomer: string;

  @Column('varchar', { length: 32 })
  vehicleType: string;
  
  @Column('boolean', { nullable: true })
  paid: boolean;

  @Column('boolean', { nullable: true })
  retired: boolean;

  // Con qué se cobró el abono por día/semana/mes. Se completa al marcarlo pagado (o al crearlo
  // ya pagado); queda en null mientras siga pendiente de cobro.
  @Column('varchar', { length: 20, nullable: true })
  paymentMetodo: 'CASH' | 'TRANSFER' | null;

  @ManyToOne(() => BoxList, (boxList) => boxList.ticketRegistrationForDays, {onDelete: 'CASCADE'})
  boxList: BoxList;

  @CreateDateColumn()
  createdAt: Date;

}
