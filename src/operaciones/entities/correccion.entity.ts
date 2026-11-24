import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Playa } from 'src/tenancy/entities/playa.entity';

export const TIPOS_CORRECCION = ['IDENTIFICACION', 'MEDIO_PAGO', 'RECIBIDO_VUELTO', 'VEHICULO', 'OTRO'] as const;
export type TipoCorreccion = (typeof TIPOS_CORRECCION)[number];
// APLICADA: el cambio ya rige. PENDIENTE: espera la revisión de administración, sin efecto todavía
// (tampoco sobre el efectivo esperado). RECHAZADA: revisada y no aplicada; queda como constancia.
export type EstadoCorreccion = 'APLICADA' | 'PENDIENTE' | 'RECHAZADA';

// Una corrección de un registro ya hecho (ver la migración Correcciones1790000058000). El original
// no se toca: `antes` guarda lo que decía, `despues` lo que pasa a decir, `efecto` cómo cambia la
// plata (para mostrarlo antes de confirmar y en el historial) y los movimientos de ajuste se
// vinculan con `movimientos.correccionId`.
@Entity({ name: 'correcciones' })
export class Correccion {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column('uuid', { nullable: true }) playaId: string | null;
  @ManyToOne(() => Playa, { nullable: true }) @JoinColumn({ name: 'playaId' }) playa: Playa | null;
  // Lo genera la pantalla al abrir el formulario: un reintento devuelve la misma corrección.
  @Index({ unique: true }) @Column('uuid') solicitudId: string;
  @Column('varchar', { length: 30 }) tipo: TipoCorreccion;
  @Column('varchar', { length: 20 }) estado: EstadoCorreccion;
  // La operación corregida: una estadía por hora o un pase (día, semana o mes).
  @Column('uuid', { nullable: true }) registrationId: string | null;
  @Column('uuid', { nullable: true }) paseId: string | null;
  // El movimiento de cobro corregido (medio de pago, recibido y vuelto).
  @Column('uuid', { nullable: true }) movimientoId: string | null;
  // Vehículo equivocado: la estadía que de verdad salió.
  @Column('uuid', { nullable: true }) destinoRegistrationId: string | null;
  // El turno de la operación original y el turno al que se imputa el efecto (el abierto de esa caja).
  @Column('uuid', { nullable: true }) turnoId: string | null;
  @Column('uuid', { nullable: true }) imputadaTurnoId: string | null;
  // Aplicada después de que la caja del turno original se contó y cerró: el arqueo original queda
  // igual (contado, esperado y diferencia) y la corrección se muestra vinculada a ese cierre.
  @Column('boolean', { default: false }) posteriorAlCierre: boolean;
  @Column('uuid') usuarioId: string;
  @Column('varchar', { length: 255, nullable: true }) usuarioNombre: string | null;
  @Column('varchar', { length: 40 }) motivo: string;
  @Column('text', { nullable: true }) detalle: string | null;
  @Column('jsonb', { default: {} }) antes: Record<string, unknown>;
  @Column('jsonb', { default: {} }) despues: Record<string, unknown>;
  @Column('jsonb', { default: {} }) efecto: Record<string, unknown>;
  // La acreditación de Mercado Pago que respalda un cambio a transferencia, o la revisión de
  // administración que la reemplaza.
  @Column('jsonb', { nullable: true }) evidencia: Record<string, unknown> | null;
  @Column('uuid', { nullable: true }) revisadoPor: string | null;
  @Column('varchar', { length: 255, nullable: true }) revisadoPorNombre: string | null;
  @Column('timestamptz', { nullable: true }) revisadoEl: Date | null;
  @Column('text', { nullable: true }) resolucion: string | null;
  @Column('timestamptz', { nullable: true }) aplicadaEl: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
