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

  // Apunta a ticket_registrations o a ticket_registration_for_days según `tipo`. Sin FK, por eso:
  // son dos tablas destino posibles. Igual que parking_receipts.
  @Column('uuid')
  registrationId: string;

  @Column('varchar', { length: 10, default: 'HORA' })
  tipo: 'HORA' | 'ABONO';

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

  // El id del pago en MercadoPago, con índice único parcial: es el seguro contra cobrar dos veces
  // el mismo pago si llegan dos avisos.
  @Column('varchar', { length: 64, nullable: true })
  mpPaymentId: string | null;

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
