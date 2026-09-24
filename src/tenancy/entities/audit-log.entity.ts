import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

// Quién cambió qué, cuándo y en qué playa. Complementa a movimientos, que registra la plata:
// acá van las acciones que no son cobros (cambiar una tarifa, forzar un ingreso duplicado,
// mover la tolerancia de salida, dar de alta un usuario).
//
// Con empresas ajenas conviviendo en la misma base deja de ser opcional.
@Entity({ name: 'audit_log' })
@Index(['empresaId', 'fecha'])
@Index(['playaId', 'fecha'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  empresaId: string;

  // Nulo para acciones que son de la empresa y no de una playa puntual (alta de usuario).
  @Column('uuid', { nullable: true })
  playaId: string | null;

  // Nulo cuando la acción no la hizo una persona (una tarea automática).
  @Column('uuid', { nullable: true })
  usuarioId: string | null;

  @Column('varchar', { length: 100 })
  accion: string;

  @Column('varchar', { length: 100 })
  entidad: string;

  @Column('varchar', { length: 100, nullable: true })
  entidadId: string | null;

  // Qué cambió, ya resumido para mostrar: { precio: 1200, vehiculo: 'AUTO' }. No guarda el
  // registro entero ni nada sensible (contraseñas, tokens): es para leer, no para restaurar.
  @Column('jsonb', { nullable: true })
  detalle: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  fecha: Date;
}
