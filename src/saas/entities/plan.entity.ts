import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// La lista de precios de la plataforma: tamaño de playa × si incluye cocheras mensuales. Es un
// catálogo, no plata de nadie: lo que paga cada playa se congela en `suscripcion_playas.precio`
// al asignarle el plan, así que cambiar un precio acá solo afecta a las asignaciones nuevas.
@Entity({ name: 'planes' })
export class Plan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Identificador estable para la semilla de la migración ("MEDIANA_COCHERAS"). El nombre se
  // puede retocar; el código no.
  @Index({ unique: true })
  @Column('varchar', { length: 40 })
  codigo: string;

  @Column('varchar', { length: 100 })
  nombre: string;

  // Estadías abiertas a la vez en la playa. Null = sin límite. Es un límite blando: nunca frena
  // un auto en la entrada, sirve para ver quién ya necesita el plan siguiente.
  @Column('int', { nullable: true })
  maxActivos: number | null;

  // Prende la sección Inquilinos (`playas.modulos.inquilinos`) de la playa que lo tenga.
  @Column('boolean', { default: false })
  incluyeCocheras: boolean;

  // Pesos enteros por mes, como el resto de la plata del sistema.
  @Column('int')
  precioMensual: number;

  // Un plan retirado deja de ofrecerse pero las playas que ya lo tienen lo conservan.
  @Column('boolean', { default: true })
  activo: boolean;

  @Column('int', { default: 0 })
  orden: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
