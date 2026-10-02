import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export const FACTURA_SAAS_ESTADO = ['PENDIENTE', 'PAGADA', 'ANULADA'] as const;
export type FacturaSaasEstado = (typeof FACTURA_SAAS_ESTADO)[number];

// Cómo entró la plata. MERCADOPAGO acá es un pago que se registra a mano (te transfirieron a tu
// cuenta de MercadoPago); el día que se cobre automático, entra con el id de pago en `referencia`.
export const MEDIO_PAGO_SAAS = [
  'TRANSFERENCIA',
  'EFECTIVO',
  'MERCADOPAGO',
  'OTRO',
] as const;
export type MedioPagoSaas = (typeof MEDIO_PAGO_SAAS)[number];

export type LineaFactura = {
  playaId: string;
  playa: string;
  planId: string;
  plan: string;
  precio: number;
};

// Lo que vos le cobrás a la empresa por un período. Nombre aparte a propósito: `receipts` ya
// significa el recibo que la playa le cobra a su abonado, que es lo contrario. Tampoco es una
// factura fiscal: es el registro interno de qué período se cobró, cuánto y cómo.
//
// La tarea diaria emite la del período siguiente unos días antes del vencimiento (PENDIENTE) y
// registrar el pago la pasa a PAGADA. Nunca se borra: un pago cargado por error se ANULA.
@Entity({ name: 'facturas_saas' })
@Index(['empresaId', 'desde'])
// Una sola pendiente por empresa: si la tarea diaria corre dos veces a la vez, la segunda choca.
@Index('facturas_saas_pendiente_unica', ['empresaId'], {
  unique: true,
  where: `estado = 'PENDIENTE'`,
})
// Un pago de MercadoPago (su id va en `referencia`) se registra una sola vez.
@Index('facturas_saas_pago_mercadopago', ['referencia'], {
  unique: true,
  where: `medio = 'MERCADOPAGO' AND referencia IS NOT NULL`,
})
export class FacturaSaas {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  empresaId: string;

  // Período cubierto: del día siguiente al vencimiento anterior hasta `hasta`, inclusive.
  @Column('date')
  desde: string;

  @Column('date')
  hasta: string;

  // Cuántos meses cubre. Un pago adelantado de tres meses es una sola factura.
  @Column('int', { default: 1 })
  meses: number;

  // Pesos enteros. Mientras está pendiente es lo que se le cobra; ya pagada, lo que pagó.
  @Column('int')
  importe: number;

  // Las playas y planes con que se calculó, para que el historial no cambie si después cambia
  // el plan.
  @Column('jsonb', { default: () => "'[]'::jsonb" })
  detalle: LineaFactura[];

  @Column('varchar', { length: 20, default: 'PENDIENTE' })
  estado: FacturaSaasEstado;

  @Column('date', { nullable: true })
  pagadaEl: string | null;

  @Column('varchar', { length: 20, nullable: true })
  medio: MedioPagoSaas | null;

  // Número de transferencia, id de pago de MercadoPago o lo que identifique el pago.
  @Column('varchar', { length: 255, nullable: true })
  referencia: string | null;

  @Column('text', { nullable: true })
  nota: string | null;

  @Column('uuid', { nullable: true })
  registradaPor: string | null;

  // El vencimiento que tenía la empresa antes de este pago: anularlo lo devuelve exacto, aunque
  // el pago haya reactivado una cuenta suspendida y corrido el período.
  @Column('date', { nullable: true })
  pagadoHastaAnterior: string | null;

  @Column('text', { nullable: true })
  motivoAnulacion: string | null;

  @Column('timestamptz', { nullable: true })
  anuladaEl: Date | null;

  @Column('uuid', { nullable: true })
  anuladaPor: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
