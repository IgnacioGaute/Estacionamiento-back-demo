import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn } from 'typeorm';
import { Receipt } from './receipt.entity';
import { BoxList } from 'src/box-lists/entities/box-list.entity';

// Los medios que se aceptan al cargar un pago a mano (DTOs de recibos, alta de cliente, escáner).
export const PAYMENT_TYPE = ['TRANSFER', 'CASH', 'CHECK', 'CREDIT', 'TP', 'MIX', 'FIX'] as const;
export type PaymentType = (typeof PAYMENT_TYPE)[number];
// Lo que puede quedar guardado: además, MERCADOPAGO, que solo lo escribe la acreditación
// automática de un cobro con QR (nunca un pedido del mostrador).
export const PAYMENT_TYPE_GUARDADO = [...PAYMENT_TYPE, 'MERCADOPAGO'] as const;
export type PaymentTypeGuardado = (typeof PAYMENT_TYPE_GUARDADO)[number];

@Entity({ name: 'receipt_payments' })
export class ReceiptPayment {
  @Column('uuid', { nullable: true })
  playaId: string | null;

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('enum', { enum: PAYMENT_TYPE_GUARDADO, nullable:true})
  paymentType: PaymentTypeGuardado;
  
  @Column('int', {nullable:true})
  price: number;

  @Column('int', {nullable:true})
  numberInBox: number;

  @Column('date', { nullable: true })
  paymentDate: string | null;

  // El asiento de la cuenta corriente del que sale esta imputación (inquilinos). Permite
  // deshacer exactamente las imputaciones de un pago al anularlo.
  @Column('uuid', { nullable: true })
  cuentaMovimientoId: string | null;

  @ManyToOne(() => Receipt, (receipt) => receipt.payments, { onDelete: 'CASCADE' })
  receipt: Receipt;

  @ManyToOne(() => BoxList, (boxList) => boxList.receiptPayments, {onDelete: 'CASCADE'})
  boxList: BoxList;

  @CreateDateColumn()
  createdAt: Date;
}
