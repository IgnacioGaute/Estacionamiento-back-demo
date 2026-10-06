import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// ESPERANDO: se busca la transferencia. REVISION: hubo más de una posibilidad y la elige el
// operador. CONFIRMADO: se asoció una transferencia (y se registró el cobro). CANCELADO: lo cortó
// el operador. VENCIDO: pasó el tiempo de espera. PAGADO_OTRO_MEDIO: la estadía se cerró por otro
// lado mientras se esperaba.
export const ESTADOS_COBRO_TRANSFERENCIA = [
  'ESPERANDO',
  'REVISION',
  'CONFIRMADO',
  'CANCELADO',
  'VENCIDO',
  'PAGADO_OTRO_MEDIO',
] as const;
export type EstadoCobroTransferencia =
  (typeof ESTADOS_COBRO_TRANSFERENCIA)[number];

// Cómo se asoció la transferencia. AUTOMATICO_COINCIDENCIA_UNICA no identifica al pagador: es la
// regla «una sola transferencia de ese importe y un solo cobro esperándola en toda la cuenta».
export type ModoAsociacion = 'AUTOMATICO_COINCIDENCIA_UNICA' | 'MANUAL';

// Un intento de cobrar una estadía por transferencia al alias. Mientras está abierto, el cobro y
// la salida NO están registrados: se registran recién al asociar una transferencia.
//
// Se lee a nivel empresa (para ver los intentos de todas las playas que cobran con la misma
// cuenta) pero solo lo crea y lo cambia su playa: ver la migración VerificacionAlias.
@Entity({ name: 'cobros_transferencia' })
@Index('tenant_cobros_transferencia', ['playaId'])
// Los mismos índices únicos que la migración, con sus nombres, para que una base creada con
// synchronize (las pruebas, el primer arranque) tenga las mismas garantías.
@Index('cobros_transferencia_abierto', ['registrationId'], {
  unique: true,
  where: `"estado" IN ('ESPERANDO', 'REVISION')`,
})
@Index('cobros_transferencia_operacion', ['mpUserId', 'operacionId'], {
  unique: true,
  where: '"operacionId" IS NOT NULL',
})
export class CobroTransferencia {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  empresaId: string;

  @Column('uuid')
  playaId: string;

  @Column('uuid')
  registrationId: string;

  // La cuenta receptora: la de la empresa al momento de abrir el intento.
  @Column('varchar', { length: 64 })
  mpUserId: string;

  // Lo que faltaba cobrar al abrir el intento, en pesos enteros. Queda congelado aunque la tarifa
  // siga corriendo: si cuando llega la plata la estadía ya cuesta más, queda un saldo chico.
  @Column('int')
  importe: number;

  @Column('varchar', { length: 3, default: 'ARS' })
  moneda: string;

  @Column('varchar', { length: 20, default: 'ESPERANDO' })
  estado: EstadoCobroTransferencia;

  // Desde cuándo se buscan transferencias: un minuto antes de abrir el intento (o cinco, si el
  // operador lo amplía), por si el cliente transfirió antes de que se eligiera el medio.
  @Column('timestamptz')
  buscarDesde: Date;

  @Column('int', { default: 1 })
  ventanaMinutos: number;

  @Column('timestamptz')
  venceEl: Date;

  // Cuándo dejó de estar abierto (confirmado, cancelado, vencido o pagado por otro medio).
  @Column('timestamptz', { nullable: true })
  cerradoEl: Date | null;

  @Column('varchar', { length: 64, nullable: true })
  operacionId: string | null;

  @Column('varchar', { length: 40, nullable: true })
  modo: ModoAsociacion | null;

  @Column('boolean', { default: false })
  salidaRegistrada: boolean;

  // Si al confirmar la estadía ya costaba más que lo transferido, lo que quedó por cobrar.
  @Column('int', { nullable: true })
  saldoPendiente: number | null;

  @Column('uuid', { nullable: true })
  creadoPor: string | null;

  @Column('uuid', { nullable: true })
  confirmadoPor: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
