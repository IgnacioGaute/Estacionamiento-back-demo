import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// numeric y no int: la plata operativa del estacionamiento son pesos enteros, pero el precio
// del plan es otra cosa y quiero decimales. TypeORM devuelve numeric como string, así que el
// transformer evita que en el código termine haciéndose "1500.00" + 100.
const aNumero = {
  to: (valor: number) => valor,
  from: (valor: string | null) => (valor === null ? null : Number(valor)),
};

@Entity({ name: 'planes' })
export class Plan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('varchar', { length: 100 })
  nombre: string;

  @Column('numeric', { precision: 12, scale: 2, transformer: aNumero })
  precioMensual: number;

  @Column('int')
  maxPlayas: number;

  @Column('int')
  maxUsuarios: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
