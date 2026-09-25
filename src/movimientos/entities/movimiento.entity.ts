import {
  Column,
  CreateDateColumn,
  Entity,
  Generated,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Playa } from 'src/tenancy/entities/playa.entity';
import { TicketRegistration } from 'src/tickets/entities/ticket-registration.entity';
import { User } from 'src/users/entities/user.entity';
import { Turno } from 'src/turnos/entities/turno.entity';

export const MOVIMIENTO_METODO = ['CASH', 'TRANSFER', 'MERCADOPAGO'] as const;
export type MovimientoMetodo = (typeof MOVIMIENTO_METODO)[number];

// Los que una persona puede elegir a mano al cobrar. MERCADOPAGO queda afuera a propósito: ese
// valor significa «MercadoPago confirmó que la plata entró», y sólo lo escribe la acreditación
// automática del cobro con QR. Si el mostrador pudiera elegirlo, pasaría a significar lo mismo
// que TRANSFER —alguien dice que le pagaron— y se perdería la única diferencia que importa.
export const MOVIMIENTO_METODO_MANUAL = ['CASH', 'TRANSFER'] as const;
export type MovimientoMetodoManual = (typeof MOVIMIENTO_METODO_MANUAL)[number];

export const MOVIMIENTO_TIPO = ['ANTICIPO', 'SALDO', 'AJUSTE', 'CORTESIA'] as const;
export type MovimientoTipo = (typeof MOVIMIENTO_TIPO)[number];

// Append-only: nunca se expone un endpoint de editar/borrar. Toda corrección es una fila
// nueva de tipo AJUSTE con motivo. El total cobrado de un ticket siempre se calcula sumando
// sus movimientos — nunca se guarda como un número suelto en otra tabla.
@Entity({ name: 'movimientos' })
export class Movimiento {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid', { nullable: true })
  playaId: string | null;

  @ManyToOne(() => Playa, { nullable: true })
  @JoinColumn({ name: 'playaId' })
  playa: Playa | null;

  // Orden inequívoco de inserción — un uuid no garantiza orden, y la futura cadena de hash
  // (hashAnterior/hash) necesita saber con certeza cuál es "el movimiento anterior".
  @Generated('increment')
  @Column('int')
  sequence: number;

  // Se ancla a TicketRegistration (la estadía concreta), no a Ticket (el código de barras
  // reutilizable, que se desvincula del registro al cerrar para liberar la tarjeta física).
  @ManyToOne(() => TicketRegistration, { nullable: true })
  @JoinColumn()
  ticketRegistration: TicketRegistration | null;

  @CreateDateColumn({ type: 'timestamptz' })
  fechaHora: Date;

  @Column('int')
  monto: number;

  @Column('enum', { enum: MOVIMIENTO_METODO })
  metodo: MovimientoMetodo;

  @Column('enum', { enum: MOVIMIENTO_TIPO })
  tipo: MovimientoTipo;

  @ManyToOne(() => User)
  @JoinColumn()
  usuario: User;

  // Nullable — el requisito de turno abierto está desactivado por ahora (ver
  // MovimientosService.create); queda la columna lista para cuando se retome.
  @ManyToOne(() => Turno, { nullable: true })
  @JoinColumn()
  turno: Turno | null;

  @Column('varchar', { length: 255, nullable: true })
  referencia: string | null;

  // Obligatorio para AJUSTE/CORTESIA — verificado en MovimientosService.create, no es una
  // restricción de base de datos.
  @Column('varchar', { length: 255, nullable: true })
  motivo: string | null;

  // Columnas listas para la cadena de hash (registro inmutable) — la lógica se arma después.
  @Column('varchar', { nullable: true })
  hashAnterior: string | null;

  @Column('varchar', { nullable: true })
  hash: string | null;
}
