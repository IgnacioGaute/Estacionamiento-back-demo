import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
@Entity({ name: 'ticket_vehicle_types' })
@Index(['playaId', 'code'], { unique: true })
export class VehicleTypeEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid', { nullable: true }) playaId: string | null;
  @Column('varchar', { length: 32 }) code: string;
  @Column('varchar', { length: 80 }) name: string;
  @Column('boolean', { default: true }) enabled: boolean;
}
