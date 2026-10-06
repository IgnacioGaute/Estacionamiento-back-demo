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
import { Playa } from 'src/tenancy/entities/playa.entity';

export interface DireccionCaja {
  calle: string;
  numero: string;
  ciudad: string;
  provincia: string;
  latitud: number;
  longitud: number;
  referencia?: string | null;
}

// La sucursal y la caja de MercadoPago de una playa, en la cuenta de la empresa. Con ella el
// cobro con QR genera un código estándar (QR interoperable) que se paga desde cualquier banco o
// billetera; sin ella, sigue siendo el link de MercadoPago. Ver la migración QrInteroperable.
@Entity({ name: 'mercadopago_cajas' })
@Index('mercadopago_cajas_playa', ['playaId', 'mpUserId'], { unique: true })
export class CajaMercadoPago {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  empresaId: string;

  @ManyToOne(() => Empresa, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'empresaId' })
  empresa?: Empresa;

  // Siempre explícita: la playa que eligió el administrador, no la que tenga activa.
  @Column('uuid')
  playaId: string;

  @ManyToOne(() => Playa, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'playaId' })
  playa?: Playa;

  // La cuenta en la que se creó. Si la empresa conecta otra, la playa necesita otra caja.
  @Column('varchar', { length: 64 })
  mpUserId: string;

  @Column('varchar', { length: 64 })
  storeId: string;

  @Column('varchar', { length: 60 })
  externalStoreId: string;

  @Column('varchar', { length: 64 })
  posId: string;

  // Con esto se crean las órdenes de cobro de la playa.
  @Column('varchar', { length: 60 })
  externalPosId: string;

  // La dirección con la que se creó la sucursal (MercadoPago la exige completa).
  @Column('jsonb', { nullable: true })
  direccion: DireccionCaja | null;

  @Column('uuid', { nullable: true })
  creadaPor: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
