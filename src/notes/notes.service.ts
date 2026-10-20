import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreateNoteDto } from './dto/create-note.dto';
import { UpdateNoteDto } from './dto/update-note.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Note } from './entities/note.entity';
import { MoreThanOrEqual, Repository, SelectQueryBuilder } from 'typeorm';
import { FilterOperator, paginate, PaginateQuery } from 'nestjs-paginate';
import { User } from 'src/users/entities/user.entity';
import { NotificationGateway } from './notification-gateway';
import { v4 as uuidv4 } from 'uuid'; 
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

// Filtros de la cartelera. El origen agrupa por sourceType: sin sourceKey lo escribió alguien del
// equipo; TICKET viene de entradas, descuentos y correcciones; CAJA/TURNO de la caja; el resto
// (cuentas y comentarios de clientes, con el tipo de cliente como sourceType) de clientes.
export const ESTADOS_AVISO = ['TODOS', 'SIN_LEER', 'LEIDOS'] as const;
export const ORIGENES_AVISO = ['TODOS', 'EQUIPO', 'VEHICULOS', 'CAJA', 'CLIENTES'] as const;
export type FiltrosAvisos = {
  estado?: (typeof ESTADOS_AVISO)[number];
  origen?: (typeof ORIGENES_AVISO)[number];
  desde?: string;
  hasta?: string;
  autor?: string;
};

// Pendiente para quien lee: no lo escribió y todavía no lo marcó. Lo propio nunca queda pendiente.
const PENDIENTE = (a: string, lector = ':readerId') =>
  `((${a}."userId" IS NULL OR ${a}."userId" != ${lector}::uuid) AND NOT (${lector}::uuid = ANY(${a}."readBy")))`;
// Día del aviso en Buenos Aires; las notas viejas sin fecha usan su creación.
const FECHA = (a: string) => `COALESCE(${a}.date, CAST(${a}."createdAt" AT TIME ZONE 'America/Argentina/Buenos_Aires' AS date))`;

const filtroInvalido = (message: string) => new BadRequestException({ code: 'FILTRO_INVALIDO', message });
const fechaValida = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && dayjs(v).format('YYYY-MM-DD') === v;

function validarFiltros(f: FiltrosAvisos): Required<FiltrosAvisos> {
  const estado = f.estado || 'TODOS';
  const origen = f.origen || 'TODOS';
  if (!ESTADOS_AVISO.includes(estado)) throw filtroInvalido('El estado del filtro no es válido.');
  if (!ORIGENES_AVISO.includes(origen)) throw filtroInvalido('El origen del filtro no es válido.');
  for (const fecha of [f.desde, f.hasta]) if (fecha && !fechaValida(fecha)) throw filtroInvalido('La fecha del filtro no es válida.');
  if (f.desde && f.hasta && f.desde > f.hasta) throw filtroInvalido('La fecha Desde no puede ser posterior a Hasta.');
  if (f.autor && !/^[0-9a-f-]{36}$/i.test(f.autor)) throw filtroInvalido('El autor del filtro no es válido.');
  return { estado, origen, desde: f.desde ?? '', hasta: f.hasta ?? '', autor: f.autor ?? '' };
}

function aplicarFiltros(qb: SelectQueryBuilder<Note>, a: string, f: Required<FiltrosAvisos>, userId?: string) {
  if (f.origen === 'EQUIPO') qb.andWhere(`${a}."sourceKey" IS NULL`);
  if (f.origen === 'VEHICULOS') qb.andWhere(`${a}."sourceKey" IS NOT NULL AND ${a}."sourceType" = 'TICKET'`);
  if (f.origen === 'CAJA') qb.andWhere(`${a}."sourceKey" IS NOT NULL AND ${a}."sourceType" IN ('CAJA', 'TURNO')`);
  if (f.origen === 'CLIENTES') qb.andWhere(`${a}."sourceKey" IS NOT NULL AND COALESCE(${a}."sourceType", '') NOT IN ('TICKET', 'CAJA', 'TURNO')`);
  if (f.desde) qb.andWhere(`${FECHA(a)} >= CAST(:desde AS date)`, { desde: f.desde });
  if (f.hasta) qb.andWhere(`${FECHA(a)} <= CAST(:hasta AS date)`, { hasta: f.hasta });
  if (f.autor) qb.andWhere(`${a}."userId" = CAST(:autor AS uuid)`, { autor: f.autor });
  if (userId) qb.setParameter('readerId', userId);
}


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
    
  async findAll(query: PaginateQuery, userId?: string, filtros: FiltrosAvisos = {}) {
    try {
      const f = validarFiltros(filtros);
      const builder = this.noteRepository.createQueryBuilder('__root');
      if (userId) {
        builder.addSelect(`CASE WHEN ${PENDIENTE('__root')} THEN 1 ELSE 0 END`, 'unread_order')
          .setParameter('readerId', userId)
          .orderBy('unread_order', 'DESC');
      }
      aplicarFiltros(builder, '__root', f, userId);
      if (userId && f.estado !== 'TODOS')
        builder.andWhere(f.estado === 'SIN_LEER' ? PENDIENTE('__root') : `NOT (${PENDIENTE('__root')})`);
      const pagina = await paginate(query, builder, {
        sortableColumns: ['id', 'date', 'createdAt'],
        nullSort: 'last',
        defaultSortBy: [['createdAt', 'DESC'], ['id', 'DESC']],
        searchableColumns: ['date', 'description', 'origin', 'context'],
        filterableColumns: {
          date: [FilterOperator.ILIKE, FilterOperator.EQ],
        },
        relations: ['user'],
      });
      if (!userId) return pagina;
      // Cuáles de esta página siguen pendientes para quien lee: la pantalla no espera otra consulta.
      const pendientes: { id: string }[] = pagina.data.length
        ? await this.noteRepository.query(`SELECT n.id FROM notes n WHERE n.id = ANY($2::uuid[]) AND ${PENDIENTE('n', '$1')}`,
          [userId, pagina.data.map((n) => n.id)])
        : [];
      return { ...pagina, pendientes: pendientes.map((p) => p.id), ...(await this.resumen(userId, f, query.search)) };
    } catch (error: any) {
      if (!(error instanceof BadRequestException)) this.logger.error(error.message, error.stack);
      throw error;
    }
  }

  // Cuántos hay en cada estado con los mismos filtros (para el selector), el resumen de la playa
  // sin filtros (pendientes, de hoy, total) y los autores que publicaron, para el filtro por autor.
  private async resumen(userId: string, f: Required<FiltrosAvisos>, search?: string) {
    const conteo = this.noteRepository.createQueryBuilder('n')
      .select('count(*)::int', 'todos')
      .addSelect(`count(*) FILTER (WHERE ${PENDIENTE('n')})::int`, 'sinLeer')
      .setParameter('readerId', userId);
    aplicarFiltros(conteo, 'n', f, userId);
    if (search?.trim())
      conteo.andWhere(`(n.date::text ILIKE :busqueda OR n.description ILIKE :busqueda OR n.origin ILIKE :busqueda OR n.context ILIKE :busqueda)`,
        { busqueda: `%${search.trim()}%` });
    const [conteos, [general], autores] = await Promise.all([
      conteo.getRawOne<{ todos: number; sinLeer: number }>(),
      this.noteRepository.query(
        `SELECT count(*)::int AS total,
           count(*) FILTER (WHERE ${PENDIENTE('n', '$1')})::int AS "sinLeer",
           count(*) FILTER (WHERE ${FECHA('n')} = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)::int AS hoy
         FROM notes n`, [userId]),
      this.noteRepository.query(
        `SELECT DISTINCT u.id, trim(concat_ws(' ', u."firstName", u."lastName")) AS nombre
         FROM notes n JOIN users u ON u.id = n."userId" ORDER BY nombre`),
    ]);
    return {
      conteos: { todos: conteos?.todos ?? 0, sinLeer: conteos?.sinLeer ?? 0, leidos: (conteos?.todos ?? 0) - (conteos?.sinLeer ?? 0) },
      resumen: general,
      autores: autores as { id: string; nombre: string }[],
    };
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
      if (note.sourceKey) throw new BadRequestException('Esta nota se modifica desde su operación original.');
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

      if (note.sourceKey) throw new BadRequestException('Este aviso conserva la nota de su operación original.');
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

  // Todos los pendientes de la playa de una vez (RLS limita a la playa actual). Lo propio no cambia.
  async markAllRead(userId: string) {
    const result = await this.noteRepository.query(
      `UPDATE notes n SET "readBy" = array_append(n."readBy", $1::uuid) WHERE ${PENDIENTE('n', '$1')}`, [userId]);
    return { success: true, leidos: result?.[1] ?? 0 };
  }

  async getTodayNotes(userId: string, pagination = { page: 1, limit: 25 }) {
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Establecer la fecha de inicio del día

    const [data, total] = await this.noteRepository.findAndCount({
      where: {
        user: { id: userId }, // Si `userId` es una relación
        createdAt: MoreThanOrEqual(today),
      },
      relations: ['user'], // Asegurar que se cargue la relación
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: (pagination.page - 1) * pagination.limit, take: pagination.limit,
    });
    return { data, meta: { totalItems: total, currentPage: pagination.page, itemsPerPage: pagination.limit, totalPages: Math.ceil(total / pagination.limit) } };
  }
  
}
