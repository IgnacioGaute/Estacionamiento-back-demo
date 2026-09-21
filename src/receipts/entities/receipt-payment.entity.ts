import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Receipt } from './receipt.entity';
import { BoxList } from 'src/box-lists/entities/box-list.entity';

export const PAYMENT_TYPE = ['TRANSFER', 'CASH', 'CHECK', 'CREDIT', 'TP', 'MIX', 'FIX'] as const;
export type PaymentType = (typeof PAYMENT_TYPE)[number];

@Entity({ name: 'receipt_payments' })
export class ReceiptPayment {
  @Column('uuid', { nullable: true })
  playaId: string | null;

  @PrimaryGeneratedColumn('uuid')
  id: string;
  
  @Column('enum', { enum: PAYMENT_TYPE, nullable:true})
  paymentType: PaymentType;
  
  @Column('int', {nullable:true})
  price: number;

  @Column('int', {nullable:true})
  numberInBox: number;

  @Column('date', { nullable: true })
  paymentDate: string | null;

  @ManyToOne(() => Receipt, (receipt) => receipt.payments, { onDelete: 'CASCADE' })
  receipt: Receipt;

  @ManyToOne(() => BoxList, (boxList) => boxList.receiptPayments, {onDelete: 'CASCADE'})
  boxList: BoxList;

  @CreateDateColumn()
  createdAt: Date;
}
