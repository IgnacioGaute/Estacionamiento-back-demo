import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
@Entity('offline_sessions')
export class OfflineSession {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') playaId: string;
  @Column('uuid') userId: string;
  @Column('uuid') deviceId: string;
  @Column('boolean', { default: true }) active: boolean;
  @Column('timestamptz') createdAt: Date;
  @Column('timestamptz') expiresAt: Date;
  @Column('jsonb') snapshot: any;
  @Column('jsonb', { default: {} }) processed: Record<string, { fingerprint: string; registrationId: string }>;
}
