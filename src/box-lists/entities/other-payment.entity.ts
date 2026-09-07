
import { Receipt } from 'src/receipts/entities/receipt.entity';
import { TicketRegistration } from 'src/tickets/entities/ticket-registration.entity';
import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BoxList } from './box-list.entity';

export const PAYMENT_TYPE = ['EGRESOS', 'INGRESOS'] as const;
export type PaymentType = (typeof PAYMENT_TYPE)[number];

export const PAYMENT_METHOD = ['CASH', 'TRANSFER'] as const;
export type PaymentMethod = (typeof PAYMENT_METHOD)[number];

@Entity({ name: 'other_payments' })
export class OtherPayment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('varchar')
  description: string;

  @Column('int')
  price: number;

  @Column('enum', { enum: PAYMENT_TYPE, nullable: true})
  type: PaymentType;

  @Column('enum', { enum: PAYMENT_METHOD, nullable: true})
  paymentMethod: PaymentMethod;

  @Column('date', { nullable: true })
  dateNow: string | null;

  @ManyToOne(() => BoxList, (boxList) => boxList.otherPayments, { cascade: true })
  boxList: BoxList;
}
