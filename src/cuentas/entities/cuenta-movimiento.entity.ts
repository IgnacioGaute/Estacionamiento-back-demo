import { Column, CreateDateColumn, Entity, Generated, Index, PrimaryGeneratedColumn } from 'typeorm';

// DEVOLUCION: plata que efectivamente se le devolvió al inquilino (sale de caja o del banco). No es
// lo mismo que anular un pago cargado por error.
export const CUENTA_TIPO = ['SALDO_INICIAL', 'CARGO', 'PAGO', 'AJUSTE', 'ANULACION', 'DEVOLUCION'] as const;
export type CuentaTipo = (typeof CUENTA_TIPO)[number];

// Los medios que puede tener un asiento. CHECK queda por la historia (la playa ya no recibe
// cheques) y MERCADOPAGO solo lo escribe la acreditación automática de un cobro con QR.
export const CUENTA_METODO = ['CASH', 'TRANSFER', 'CHECK', 'MERCADOPAGO'] as const;
export type CuentaMetodo = (typeof CUENTA_METODO)[number];

// Los que se eligen a mano al cobrar o devolver: nada de cheque ni de MercadoPago, que se
// verifica contra MercadoPago y no por lo que diga el mostrador.
export const CUENTA_METODO_MANUAL = ['CASH', 'TRANSFER'] as const;
export type CuentaMetodoManual = (typeof CUENTA_METODO_MANUAL)[number];

// Un asiento de la cuenta corriente de un inquilino. Append-only: la base no le da al rol de la
// app permiso de UPDATE ni DELETE sobre esta tabla. `importe` positivo es lo que el inquilino
// debe (saldo inicial deudor, cargo, recargo); negativo es lo que pagó o se le reconoce. El saldo
// es la suma de todo, nunca un número guardado aparte.
@Entity({ name: 'cuenta_movimientos' })
@Index('cuenta_movimientos_solicitud_unica', ['solicitud', 'metodo'], { unique: true, where: '"solicitud" IS NOT NULL' })
export class CuentaMovimiento {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  playaId: string;

  @Column('uuid')
  customerId: string;

  @Generated('increment')
  @Column('bigint')
  sequence: string;

  // Día de negocio en Argentina. Para un cargo es el mes que cobra; para un pago, el día en que
  // entró la plata.
  @Column('date')
  fecha: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column('varchar', { length: 20 })
  tipo: CuentaTipo;

  @Column('int')
  importe: number;

  @Column('varchar', { length: 160 })
  concepto: string;

  @Column('varchar', { length: 20, nullable: true })
  metodo: CuentaMetodo | null;

  // El recibo que origina el asiento (cargo, saldo inicial por mes, recargo).
  @Column('uuid', { nullable: true })
  receiptId: string | null;

  // La fila que esta anula (sólo en ANULACION).
  @Column('uuid', { nullable: true })
  anulaId: string | null;

  // Número del comprobante de pago. Las filas de un pago con varios medios comparten número.
  @Column('varchar', { length: 30, nullable: true })
  numero: string | null;

  @Column('varchar', { length: 255, nullable: true })
  motivo: string | null;

  @Column('uuid', { nullable: true })
  usuarioId: string | null;

  @Column('jsonb', { nullable: true })
  detalle: Record<string, unknown> | null;

  // Identificador que manda la pantalla con cada cobro o devolución. Si la respuesta se pierde y
  // el operador reintenta, llega el mismo: se devuelve lo ya registrado en vez de cobrar dos veces.
  @Column('uuid', { nullable: true })
  solicitud: string | null;
}
