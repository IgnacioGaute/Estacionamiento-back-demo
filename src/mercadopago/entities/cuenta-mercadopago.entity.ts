import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// La cuenta de MercadoPago con la que cobra una empresa. La conecta su ADMIN desde el panel: sale
// al sitio de MercadoPago, inicia sesión con su cuenta y autoriza; acá vuelven los tokens.
//
// Por qué la conexión es de la empresa y no de la playa: MercadoPago autoriza una aplicación por
// cuenta de vendedor, así que volver a autorizar la misma cuenta para una segunda playa puede
// invalidar el token de la primera. Una empresa con varias playas cobra con una sola cuenta. Si
// más adelante una playa necesita la suya, se agrega como excepción, no como norma.
//
// Tampoco lleva columna `playaId` a propósito: el subscriber de tenant-context estampa esa columna
// en cualquier entidad que la tenga, así que una fila de alcance «toda la empresa» quedaría atada
// en silencio a la playa que estuviera activa al conectarla.
@Entity({ name: 'mercadopago_cuentas' })
@Index(['empresaId'], { unique: true })
export class CuentaMercadoPago {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  empresaId: string;

  // El id de vendedor en MercadoPago (`user_id` / collector). Es lo que identifica la cuenta que
  // cobra, y lo que después aparece en cada pago.
  @Column('varchar', { length: 64 })
  mpUserId: string;

  // Para que el admin verifique de un vistazo QUÉ cuenta quedó conectada. Si el navegador tenía
  // abierta la sesión de otra persona, MercadoPago no vuelve a pedir la contraseña y se conecta la
  // cuenta equivocada sin que nadie se dé cuenta.
  @Column('varchar', { length: 255, nullable: true })
  nickname: string | null;

  @Column('varchar', { length: 255, nullable: true })
  email: string | null;

  // Cifrados con AES-256-GCM (token-crypto.ts). Nunca bajan al navegador.
  @Column('text')
  accessToken: string;

  @Column('text')
  refreshToken: string;

  // MercadoPago da tokens de 180 días. Vencido y sin renovar, la playa deja de poder cobrar por QR.
  @Column('timestamptz')
  expiraEl: Date;

  // varchar y no enum de Postgres: `ALTER TYPE ... ADD VALUE` no corre dentro de una transacción,
  // así que sumar un estado obligaría a una migración aparte (mismo criterio que Empresa.estado).
  @Column('varchar', { length: 20, default: 'ACTIVA' })
  estado: 'ACTIVA' | 'DESCONECTADA' | 'ERROR';

  // Qué pasó la última vez que se intentó usar o renovar la cuenta, para poder decirle al admin
  // por qué dejó de andar en vez de un «no se pudo cobrar» a secas.
  @Column('varchar', { length: 255, nullable: true })
  ultimoError: string | null;

  @Column('uuid', { nullable: true })
  conectadaPor: string | null;

  @Column('timestamptz', { nullable: true })
  conectadaEl: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
