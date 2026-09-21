import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Customer } from './customer.entity';

@Entity({ name: 'interest_settings' })
export class InterestSettings {
  @Column('uuid', { nullable: true })
  playaId: string | null;

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('int') 
  interestOwner: number;

  @Column('int') 
  interestRenter: number;

  @UpdateDateColumn()
  updatedAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
