import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Receipt } from './receipt.entity';
import { BoxList } from 'src/box-lists/entities/box-list.entity';

export const PAYMENT_TYPE = ['TRANSFER', 'CASH', 'CHECK', 'CREDIT', 'TP', 'MIX'] as const;
export type PaymentType = (typeof PAYMENT_TYPE)[number];

@Entity({ name: 'payments_history_on_account' })
export class PaymentHistoryOnAccount {
  @Column('uuid', { nullable: true })
  playaId: string | null;

  @PrimaryGeneratedColumn('uuid')
  id: string;
  
  @Column('enum', { enum: PAYMENT_TYPE, nullable:true})
  paymentType: PaymentType;
  
  @Column('int', {nullable:true})
  price: number;

  @Column('date', { nullable: true })
  paymentDate: string | null;

  @ManyToOne(() => Receipt, (receipt) => receipt.paymentHistoryOnAccount, { onDelete: 'CASCADE' })
  receipt: Receipt;

  @ManyToOne(() => BoxList, (boxList) => boxList.paymentHistoryOnAccount, {onDelete: 'CASCADE'})
  boxList: BoxList;
}
