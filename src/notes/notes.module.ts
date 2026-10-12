import { Module } from '@nestjs/common';
import { NotesService } from './notes.service';
import { NotesController } from './notes.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Note } from './entities/note.entity';
import { User } from 'src/users/entities/user.entity';
import { NotificationGateway } from './notification-gateway';
import { DataSource } from 'typeorm';
import { installAutomaticNoteNotifications } from './automatic-note';

@Module({
  imports: [TypeOrmModule.forFeature([Note, User])],
  controllers: [NotesController],
  providers: [NotesService, NotificationGateway],
})
export class NotesModule {
  constructor(ds: DataSource, gateway: NotificationGateway) {
    installAutomaticNoteNotifications(ds, data => gateway.sendNotification(data));
  }
}
