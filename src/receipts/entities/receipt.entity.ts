import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BoxList } from 'src/box-lists/entities/box-list.entity';
import { Customer } from 'src/customers/entities/customer.entity';
import { ReceiptPayment } from './receipt-payment.entity';
import { PaymentHistoryOnAccount } from './payment-history-on-account.entity';

export const PAYMENT_STATUS_TYPE = ['PENDING', 'PAID'] as const;
export type PaymentStatusType = (typeof PAYMENT_STATUS_TYPE)[number];

export const PAYMENT_TYPE = ['TRANSFER', 'CASH', 'CHECK', 'MIX', 'CREDIT', 'TP', 'FIX'] as const;
export type PaymentType = (typeof PAYMENT_TYPE)[number];

@Entity({ name: 'receipts' })
export class Receipt {
  @Column('uuid', { nullable: true })
  playaId: string | null;

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('enum', { enum: PAYMENT_STATUS_TYPE, default:'PENDING'})
  status: PaymentStatusType;

  @Column('enum', { enum: PAYMENT_TYPE, nullable:true})
  paymentType: PaymentType;

  @Column('date', { nullable: true })
  paymentDate: string | null;

  @Column('date', { nullable: true })
  startDate: string | null;

  @Column('int', { nullable: true })
  price: number;

  @Column('varchar', { nullable: true })
  receiptNumber: string;  

  @Column('int', { nullable: true })
  startAmount: number;
  
  @Column('date', { nullable: true })
  dateNow: string | null;

  @Column('varchar', { nullable: true })
  barcode: string;  

  @Column('varchar', { nullable: true })
  receiptTypeKey: string;

  @ManyToOne(() => Customer, (customer) => customer.receipts, { onDelete: 'CASCADE' })
  @JoinColumn()
  customer: Customer;

  @ManyToOne(() => BoxList, (boxList) => boxList.receipts, {onDelete: 'CASCADE'})
  boxList: BoxList;

  @OneToMany(() => ReceiptPayment, (payment) => payment.receipt, { cascade: true, nullable: true })
  payments: ReceiptPayment[];

  @OneToMany(() => PaymentHistoryOnAccount, (paymentHistoryOnAccount) => paymentHistoryOnAccount.receipt, { cascade: true, nullable: true })
  paymentHistoryOnAccount: PaymentHistoryOnAccount[];
  
  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updateAt: Date;

  @DeleteDateColumn()
  deletedAt: Date;
}
