import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
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
// Lo guardado admite además MERCADOPAGO (un cargo saldado con un cobro por QR); los DTOs siguen
// usando PAYMENT_TYPE, así nadie lo puede declarar a mano.
export const PAYMENT_TYPE_GUARDADO = [...PAYMENT_TYPE, 'MERCADOPAGO'] as const;
export type PaymentTypeGuardado = (typeof PAYMENT_TYPE_GUARDADO)[number];

export const TIPO_CARGO = ['ABONO', 'RECARGO', 'SALDO_INICIAL'] as const;
export type TipoCargo = (typeof TIPO_CARGO)[number];

@Entity({ name: 'receipts' })
@Index('receipts_cargo_periodo_unico', ['customer', 'periodo'], {
  unique: true,
  where: '"periodo" IS NOT NULL AND "deletedAt" IS NULL',
})
export class Receipt {
  @Column('uuid', { nullable: true })
  playaId: string | null;

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('enum', { enum: PAYMENT_STATUS_TYPE, default:'PENDING'})
  status: PaymentStatusType;

  @Column('enum', { enum: PAYMENT_TYPE_GUARDADO, nullable:true})
  paymentType: PaymentTypeGuardado;

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

  // Qué cobra el recibo. Null en los viejos, que eran siempre la cuota del mes.
  @Column('varchar', { length: 160, nullable: true })
  concepto: string | null;

  // Sólo inquilinos: para ellos esta fila es un cargo de su cuenta corriente (lo que se debe),
  // no un comprobante de pago. El tipo va en su propio campo para no depender del texto.
  @Column('varchar', { length: 20, nullable: true })
  tipoCargo: TipoCargo | null;

  // Mes al que corresponde un abono (o la deuda inicial de un mes). Un inquilino tiene a lo sumo
  // un cargo por período: el índice único impide duplicarlo aunque lleguen dos pedidos juntos.
  @Column('char', { length: 7, nullable: true })
  periodo: string | null;

  // Desde cuándo lo impago de este cargo está vencido (y no solo pendiente).
  @Column('date', { nullable: true })
  vencimiento: string | null;

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
