import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// Cada cuánto paga una empresa y con qué descuento: mensual, trimestral, anual (los de la landing).
// Es un catálogo como `planes`: el descuento se congela en la cuenta de cada empresa al asignarle el
// período (`suscripciones.periodoDescuento`), así que cambiarlo acá solo afecta a las nuevas.
@Entity({ name: 'periodos_pago' })
export class PeriodoPago {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // MENSUAL, TRIMESTRAL, ANUAL. Estable: es lo que guarda la cuenta de cada empresa.
  @Index({ unique: true })
  @Column('varchar', { length: 20 })
  codigo: string;

  @Column('varchar', { length: 60 })
  nombre: string;

  // Cuántos meses cubre cada pago. Fijo por código: cambiarlo reescribiría el ciclo de todas.
  @Column('int')
  meses: number;

  // Porcentaje entero de descuento sobre el precio de esos meses.
  @Column('int', { default: 0 })
  descuento: number;

  // Uno retirado deja de ofrecerse; las empresas que ya lo tienen lo conservan.
  @Column('boolean', { default: true })
  activo: boolean;

  @Column('int', { default: 0 })
  orden: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
