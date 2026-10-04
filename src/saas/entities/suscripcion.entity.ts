import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Empresa } from 'src/tenancy/entities/empresa.entity';

export const MOTIVO_SUSPENSION = ['FALTA_DE_PAGO', 'MANUAL'] as const;
export type MotivoSuspension = (typeof MOTIVO_SUSPENSION)[number];

export type DebitoEstado = 'pending' | 'authorized' | 'paused' | 'cancelled';

// La cuenta de cada empresa con la plataforma: una fila por empresa. No guarda un "estado": el
// estado (prueba, al día, vencida…) se deduce de estas fechas en `estado-cuenta.ts`, así nunca
// queda desfasado de ellas. Lo único que corta el acceso sigue siendo `empresas.estado`, que la
// tarea diaria pasa a SUSPENDIDA cuando vence la gracia.
@Entity({ name: 'suscripciones' })
export class Suscripcion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column('uuid')
  empresaId: string;

  @OneToOne(() => Empresa, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'empresaId' })
  empresa: Empresa;

  // Desde cuándo es cliente. Editable: es la fecha real de inicio, no la de carga en el sistema.
  // Mientras no pagó nunca, la prueba se cuenta desde acá.
  @Column('date', {
    default: () =>
      "(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date",
  })
  alta: string;

  // Último día de la prueba gratis (alta + días − 1; el día anterior al alta si no tuvo prueba).
  // Null mientras la cuenta no se activó.
  @Column('date', { nullable: true })
  pruebaHasta: string | null;

  // Último día cubierto por lo que pagó. Null mientras no pagó nunca.
  @Column('date', { nullable: true })
  pagadoHasta: string | null;

  // Días de acceso regalados a una empresa vencida, sin mover su fecha de vencimiento: la
  // próxima factura sigue arrancando donde terminó lo pagado.
  @Column('date', { nullable: true })
  prorrogaHasta: string | null;

  // No se le cobra (la cuenta propia, una demo, un acuerdo): nunca vence ni se suspende sola.
  @Column('boolean', { default: false })
  bonificada: boolean;

  // Por qué está suspendida. Solo la tarea diaria y un pago reactivan una FALTA_DE_PAGO; una
  // suspensión MANUAL la levanta únicamente el super admin.
  @Column('varchar', { length: 20, nullable: true })
  motivoSuspension: MotivoSuspension | null;

  @Column('timestamptz', { nullable: true })
  suspendidaEl: Date | null;

  // Nota interna del super admin ("paga por transferencia a fin de mes"). La empresa no la ve.
  @Column('text', { nullable: true })
  notas: string | null;

  // Débito automático con MercadoPago (una suscripción de MercadoPago, «preapproval», en la
  // cuenta de la plataforma). La tarjeta la carga el cliente en MercadoPago: acá nunca hay datos
  // de tarjeta, solo el id para consultarla y su estado.
  @Index()
  @Column('varchar', { length: 64, nullable: true })
  debitoId: string | null;

  // El de MercadoPago tal cual: pending (falta que la confirme), authorized (cobra sola),
  // paused, cancelled.
  @Column('varchar', { length: 20, nullable: true })
  debitoEstado: DebitoEstado | null;

  // El email de la cuenta de MercadoPago con la que la autorizó (MercadoPago lo exige).
  @Column('varchar', { length: 255, nullable: true })
  debitoEmail: string | null;

  // A dónde volver si quedó a medio confirmar.
  @Column('text', { nullable: true })
  debitoUrl: string | null;

  // El importe que tiene cargado MercadoPago: si cambia el plan, se actualiza.
  @Column('int', { nullable: true })
  debitoImporte: number | null;

  // Cada cuánto paga (`periodos_pago.codigo`). Los meses y el descuento se congelan al asignarlo,
  // como el precio pactado de cada playa: cambiar el catálogo no le cambia la cuenta a nadie.
  @Column('varchar', { length: 20, default: 'MENSUAL' })
  periodo: string;

  @Column('int', { default: 1 })
  periodoMeses: number;

  // Porcentaje entero sobre el precio de esos meses.
  @Column('int', { default: 0 })
  periodoDescuento: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
