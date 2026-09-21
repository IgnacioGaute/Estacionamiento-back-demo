
import { Receipt } from 'src/receipts/entities/receipt.entity';
import { TicketRegistration } from 'src/tickets/entities/ticket-registration.entity';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Playa } from 'src/tenancy/entities/playa.entity';
import { OtherPayment } from './other-payment.entity';
import { TicketRegistrationForDay } from 'src/tickets/entities/ticket-registration-for-day.entity';
import { ReceiptPayment } from 'src/receipts/entities/receipt-payment.entity';
import { PaymentHistoryOnAccount } from 'src/receipts/entities/payment-history-on-account.entity';

// Una caja por playa y por día, y la numeración también corre por playa: si fuera global,
// dos playas de la misma empresa compartirían la numeración de caja.
@Index(['playaId', 'date'], { unique: true })
@Index(['playaId', 'boxNumber'], { unique: true })
@Entity({ name: 'box_lists' })
export class BoxList {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid', { nullable: true })
  playaId: string | null;

  @ManyToOne(() => Playa, { nullable: true })
  @JoinColumn({ name: 'playaId' })
  playa: Playa | null;
  
  @Column('date')
  date: string | null;

  @Column('int')
  totalPrice: number;

  @Column('int', {nullable:true})
  boxNumber: number;

  @OneToMany(() => TicketRegistration, (ticketRegistration) => ticketRegistration.boxList, { cascade: true })
  ticketRegistrations: TicketRegistration[];

  @OneToMany(() => TicketRegistrationForDay, (ticketRegistrationForDays) => ticketRegistrationForDays.boxList, { cascade: true })
  ticketRegistrationForDays: TicketRegistrationForDay[];

  @OneToMany(() => Receipt, (receipts) => receipts.boxList)
  receipts: Receipt[];

  @OneToMany(() => ReceiptPayment, (receiptPayments) => receiptPayments.boxList)
  receiptPayments: ReceiptPayment[];

  @OneToMany(() => PaymentHistoryOnAccount, (paymentHistoryOnAccount) => paymentHistoryOnAccount.boxList, { cascade: true, nullable: true })
  paymentHistoryOnAccount: PaymentHistoryOnAccount[];

  @OneToMany(() => OtherPayment, (otherPayments) => otherPayments.boxList)
  otherPayments: OtherPayment[];
}
