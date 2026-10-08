import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Empresa } from 'src/tenancy/entities/empresa.entity';
import { ModoAsociacion } from './cobro-transferencia.entity';

// DISPONIBLE: entró y no se usó. REVISION: coincidió con más de un cobro (o hubo más de una
// transferencia para el mismo cobro); desde ahí nunca se asocia sola, solo a mano. USADA:
// asociada a un cobro, para siempre: anular la salida después no la libera.
export type EstadoTransferencia = 'DISPONIBLE' | 'REVISION' | 'USADA';

// Una transferencia que entró a la cuenta de la empresa y coincidió con algún intento de cobro.
// Es la evidencia mínima de la conciliación: operación, cuenta, importe, moneda, estado y fechas.
// No guarda nada de quien pagó (eso se muestra en el momento y no se persiste).
//
// Es de la cuenta (empresa), no de una playa: cualquier playa de la empresa la ve, y la toma la
// primera que la confirma. El índice único (mpUserId, operacionId) es lo que impide usarla dos veces.
@Entity({ name: 'transferencias_recibidas' })
@Index('transferencias_recibidas_operacion', ['mpUserId', 'operacionId'], {
  unique: true,
})
@Index('transferencias_recibidas_cobro', ['cobroId'], {
  unique: true,
  where: '"cobroId" IS NOT NULL',
})
export class TransferenciaRecibida {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  empresaId: string;

  @ManyToOne(() => Empresa)
  @JoinColumn({ name: 'empresaId' })
  empresa?: Empresa;

  @Column('varchar', { length: 64 })
  mpUserId: string;

  // El id estable de la operación en MercadoPago. Nunca se identifica por importe y fecha.
  @Column('varchar', { length: 64 })
  operacionId: string;

  // Con centavos, tal como lo informa MercadoPago.
  @Column('numeric', {
    precision: 14,
    scale: 2,
    transformer: {
      to: (v: number) => v,
      from: (v: string | number) => Number(v),
    },
  })
  importe: number;

  @Column('varchar', { length: 3 })
  moneda: string;

  @Column('varchar', { length: 30 })
  estadoMp: string;

  @Column('varchar', { length: 40, nullable: true })
  paymentTypeId: string | null;

  // Cuándo se hizo la operación en MercadoPago.
  @Column('timestamptz')
  fechaOperacion: Date;

  @Column('timestamptz', { nullable: true })
  fechaAcreditacion: Date | null;

  // Cuándo la vio el sistema por primera vez (distinto de cuándo se hizo).
  @Column('timestamptz', { default: () => 'now()' })
  detectadaEl: Date;

  @Column('varchar', { length: 20, default: 'DISPONIBLE' })
  estado: EstadoTransferencia;

  @Column('uuid', { nullable: true })
  cobroId: string | null;

  @Column('uuid', { nullable: true })
  registrationId: string | null;

  // No se llama playaId a propósito: ver la migración VerificacionAlias.
  @Column('uuid', { nullable: true })
  usadaEnPlayaId: string | null;

  @Column('varchar', { length: 40, nullable: true })
  modo: ModoAsociacion | null;

  @Column('timestamptz', { nullable: true })
  usadaEl: Date | null;

  @Column('uuid', { nullable: true })
  usadaPor: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
