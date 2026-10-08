import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// Un pedido de pago por QR para una estadía. Es lo que se le muestra al cliente y lo que después
// se consulta contra MercadoPago para saber si pagó.
//
// El `id` de esta fila viaja a MercadoPago como `external_reference`: es lo que permite preguntar
// «¿este cobro puntual entró?» y tener una respuesta exacta, en vez de adivinar por importe y hora
// como habría que hacer con una transferencia suelta.
@Entity({ name: 'cobros_mercadopago' })
@Index(['playaId'])
@Index(['registrationId'])
export class CobroMercadoPago {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid', { nullable: true })
  playaId: string | null;

  // Apunta a ticket_registrations, a ticket_registration_for_days o —para un inquilino— al cliente
  // (customers), según `tipo`. Sin FK, por eso: son varias tablas destino. Igual que parking_receipts.
  @Column('uuid')
  registrationId: string;

  @Column('varchar', { length: 10, default: 'HORA' })
  tipo: 'HORA' | 'ABONO' | 'INQUILINO';

  // Solo inquilinos: qué cargos cubrir primero y la nota, para asentar el pago cuando se acredite
  // igual que si se hubiera cobrado en el mostrador.
  @Column('jsonb', { nullable: true })
  detalle: { receiptIds?: string[]; nota?: string | null } | null;

  // Congelado al generar el QR. La tarifa sigue corriendo mientras el cliente paga, así que el
  // importe que se cobra es el que se le mostró, y la diferencia —si la hay— queda como saldo.
  @Column('int')
  monto: number;

  @Column('varchar', { length: 20, default: 'PENDIENTE' })
  estado: 'PENDIENTE' | 'ACREDITADO' | 'VENCIDO' | 'CANCELADO';

  @Column('varchar', { length: 64 })
  preferenceId: string;

  // La URL de pago. Es lo que se dibuja como QR y lo que se manda por WhatsApp: una sola cosa
  // sirve para los dos canales.
  @Column('text')
  initPoint: string;

  // Cuando la playa tiene caja de MercadoPago: la orden y el código QR estándar, que se paga desde
  // cualquier banco o billetera. Sin caja quedan vacíos y el QR es `initPoint`.
  @Column('varchar', { length: 64, nullable: true })
  ordenId: string | null;

  @Column('text', { nullable: true })
  qrData: string | null;

  // El id del pago en MercadoPago, con índice único parcial: es el seguro contra cobrar dos veces
  // el mismo pago si llegan dos avisos.
  @Column('varchar', { length: 64, nullable: true })
  mpPaymentId: string | null;

  @Column('varchar', { length: 40, nullable: true })
  paymentTypeId: string | null;

  @Column('timestamptz')
  expiraEl: Date;

  @Column('timestamptz', { nullable: true })
  acreditadoEl: Date | null;

  @Column('uuid', { nullable: true })
  creadoPor: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
