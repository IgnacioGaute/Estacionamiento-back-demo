import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreateNoteDto } from './dto/create-note.dto';
import { UpdateNoteDto } from './dto/update-note.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Note } from './entities/note.entity';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { FilterOperator, paginate, Paginated, PaginateQuery } from 'nestjs-paginate';
import { User } from 'src/users/entities/user.entity';
import { NotificationGateway } from './notification-gateway';
import { v4 as uuidv4 } from 'uuid'; 
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);


@Injectable()
export class NotesService {
    private readonly logger = new Logger(NotesService.name);
    
    constructor(
      @InjectRepository(Note)
      private readonly noteRepository: Repository<Note>,
      @InjectRepository(User)
      private readonly userRepository: Repository<User>,
      private readonly notificationGateway: NotificationGateway,
    ) {}

    async create(createNoteDto: CreateNoteDto, userId: string) {
      try {
        const user = await this.userRepository.findOne({
          where: { id: userId },
        });
    
        if (!user) {
          throw new NotFoundException(`User not found`);
        }
    
        const note = this.noteRepository.create({
          ...createNoteDto,
          user,
        });
    
        // Zona horaria de Argentina
        const argentinaTime = (dayjs().tz('America/Argentina/Buenos_Aires') as dayjs.Dayjs);

    
        note.date = argentinaTime.format('YYYY-MM-DD');
        note.hours = argentinaTime.format('HH:mm:ss');
    
        await this.noteRepository.save(note);
    
        const notificationId = uuidv4();
    
        this.notificationGateway.sendNotification({
          id: notificationId,
          type: 'NEW_NOTE',
          noteId: note.id,
          authorId: userId,
        });
    
        return note;
      } catch (error: any) {
        this.logger.error(error.message, error.stack);
        throw error;
      }
    }
    
  async findAll(query: PaginateQuery): Promise<Paginated<Note>> {
    try {
      return await paginate(query, this.noteRepository, {
        sortableColumns: ['id', 'date', 'createdAt'],
        nullSort: 'last',
        defaultSortBy: [['createdAt', 'DESC']],
        searchableColumns: ['date', 'description'],
        filterableColumns: {
          date: [FilterOperator.ILIKE, FilterOperator.EQ],
        },
        relations: ['user'],
      });
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
    }
  }

  async findOne(id: string) {
    try {
      const note = await this.noteRepository.findOne({
        where: { id },
        relations: ['user'],
      });
  
      if (!note) {
        throw new NotFoundException(`Note not found`);
      }
  
      return note;
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }
  

  async update(id: string, updateNoteDto: UpdateNoteDto) {
    try {
      const note = await this.noteRepository.findOne({
        where: { id },
        relations: ['user'],
      });
  
      if (!note) {
        throw new NotFoundException(`Note not found`);
      }
      const updateNote = await this.noteRepository.merge(note, updateNoteDto);

      const savedNote = await this.noteRepository.save(updateNote);

      return savedNote
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  async remove(id: string) {
    try{
      const note = await this.noteRepository.findOne({
        where: { id },
        relations: ['user'],
      });
  
      if (!note) {
        throw new NotFoundException(`Note not found`);
      }

      await this.noteRepository.remove(note);

      return {message: 'Note removed successfully'}
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }
  async unread(userId: string) {
    const notes = await this.noteRepository.createQueryBuilder('n')
      .leftJoin('n.user', 'author')
      .select('n.id', 'id')
      .where('(author.id IS NULL OR author.id != :userId)', { userId })
      .andWhere('NOT (:userId = ANY(n."readBy"))', { userId })
      .getRawMany<{ id: string }>();
    return notes.map(note => note.id);
  }

  async markRead(id: string, userId: string) {
    await this.findOne(id); // Tenant-scoped existence check before updating.
    await this.noteRepository.createQueryBuilder().update(Note)
      .set({ readBy: () => 'array_append("readBy", :userId::uuid)' })
      .where('id = :id', { id })
      .andWhere('NOT (:userId::uuid = ANY("readBy"))', { userId })
      .execute();
    return { success: true };
  }

  async getTodayNotes(userId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Establecer la fecha de inicio del día

    return this.noteRepository.find({
      where: {
        user: { id: userId }, // Si `userId` es una relación
        createdAt: MoreThanOrEqual(today),
      },
      relations: ['user'], // Asegurar que se cargue la relación
    });
  }
  
}
