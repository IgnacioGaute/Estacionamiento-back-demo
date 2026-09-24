import { hash } from 'bcryptjs';
import { ConflictException } from '@nestjs/common';
import {
  CreateEmpresaUsuarioDto,
  UpdateEmpresaUsuarioDto,
} from './dto/empresa-usuario.dto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { Empresa } from './entities/empresa.entity';
import { Playa } from './entities/playa.entity';
import { UsuarioPlaya } from './entities/usuario-playa.entity';
import { AuditLog } from './entities/audit-log.entity';
import { User } from 'src/users/entities/user.entity';
import { CreateEmpresaDto } from './dto/create-empresa.dto';
import { UpdateEmpresaDto } from './dto/update-empresa.dto';
import { CreatePlayaDto } from './dto/create-playa.dto';
import { UpdatePlayaDto } from './dto/update-playa.dto';
import { AsignarPlayasDto } from './dto/asignar-playas.dto';

// Administración de la plataforma. Todo lo de acá lo usa únicamente el super admin.
@Injectable()
export class TenancyService {
  private readonly logger = new Logger(TenancyService.name);

  constructor(
    @InjectRepository(Empresa)
    private readonly empresaRepository: Repository<Empresa>,
    @InjectRepository(Playa)
    private readonly playaRepository: Repository<Playa>,
    @InjectRepository(UsuarioPlaya)
    private readonly usuarioPlayaRepository: Repository<UsuarioPlaya>,
    @InjectRepository(User) private readonly userRepository: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  async createUsuario(empresaId: string, dto: CreateEmpresaUsuarioDto) {
    if (!(await this.empresaRepository.existsBy({ id: empresaId })))
      throw new NotFoundException('Empresa no encontrada.');
    const usuario = this.userRepository.create({
      ...dto,
      empresaId,
      password: await hash(dto.password, 10),
    });
    return this.guardarUsuario(usuario);
  }

  private async usuarioDeEmpresa(empresaId: string, id: string) {
    const usuario = await this.userRepository.findOneBy({ id, empresaId });
    if (!usuario || usuario.role === 'SUPER_ADMIN')
      throw new NotFoundException('Usuario no encontrado en esta empresa.');
    return usuario;
  }

  async updateUsuario(
    empresaId: string,
    id: string,
    dto: UpdateEmpresaUsuarioDto,
  ) {
    const usuario = await this.usuarioDeEmpresa(empresaId, id);
    const { password, ...datos } = dto;
    Object.assign(usuario, datos);
    if (password) usuario.password = await hash(password, 10);
    return this.guardarUsuario(usuario);
  }

  private async guardarUsuario(usuario: User) {
    try {
      const guardado = await this.userRepository.save(usuario);
      const { password, ...publico } = guardado;
      return publico;
    } catch (error) {
      if (error?.code === '23505')
        throw new ConflictException(
          'El email o el nombre de usuario ya está registrado.',
        );
      throw error;
    }
  }

  async removeUsuario(empresaId: string, id: string) {
    await this.usuarioDeEmpresa(empresaId, id);
    // Conservamos la identidad en el historial de operaciones.
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(UsuarioPlaya).delete({ usuarioId: id });
      await manager.getRepository(User).softDelete(id);
    });
    return { message: 'Usuario dado de baja. Su historial se conserva.' };
  }

  // Una empresa con sus playas y sus usuarios: es la única vista que necesita el super admin.
  async findAllEmpresas() {
    const empresas = await this.empresaRepository.find({
      relations: ['playas'],
      order: { nombre: 'ASC' },
    });
    if (empresas.length === 0) return [];

    const usuarios = await this.userRepository.find({
      where: { empresaId: In(empresas.map((e) => e.id)) },
      order: { firstName: 'ASC' },
    });
    const asignaciones = await this.usuarioPlayaRepository.find({
      where: {
        usuarioId: In(
          usuarios
            .map((u) => u.id)
            .concat('00000000-0000-0000-0000-000000000000'),
        ),
      },
    });

    return empresas.map((empresa) => ({
      ...empresa,
      playas: [...(empresa.playas ?? [])].sort((a, b) =>
        a.nombre.localeCompare(b.nombre),
      ),
      usuarios: usuarios
        .filter((u) => u.empresaId === empresa.id)
        .map((u) => ({
          id: u.id,
          firstName: u.firstName,
          lastName: u.lastName,
          email: u.email,
          username: u.username,
          role: u.role,
          playaIds: asignaciones
            .filter((a) => a.usuarioId === u.id)
            .map((a) => a.playaId),
        })),
    }));
  }

  async createEmpresa(dto: CreateEmpresaDto) {
    const empresa = this.empresaRepository.create({
      nombre: dto.nombre.trim(),
      estado: dto.estado ?? 'ACTIVA',
    });
    return this.empresaRepository.save(empresa);
  }

  async updateEmpresa(id: string, dto: UpdateEmpresaDto) {
    const empresa = await this.empresaRepository.findOne({ where: { id } });
    if (!empresa) throw new NotFoundException('Empresa no encontrada.');
    return this.empresaRepository.save(
      this.empresaRepository.merge(empresa, dto),
    );
  }

  // Borrar una empresa se lleva puestas sus playas y con ellas toda la operación. Se exige que
  // no queden playas ni usuarios: si no, un clic borra meses de tickets y caja sin aviso.
  async removeEmpresa(id: string) {
    const empresa = await this.empresaRepository.findOne({
      where: { id },
      relations: ['playas'],
    });
    if (!empresa) throw new NotFoundException('Empresa no encontrada.');

    if ((empresa.playas ?? []).length > 0) {
      throw new BadRequestException({
        code: 'EMPRESA_CON_PLAYAS',
        message:
          'La empresa tiene playas. Solo se pueden eliminar playas sin registros asociados.',
      });
    }
    const usuarios = await this.userRepository.count({
      where: { empresaId: id },
      withDeleted: true,
    });
    if (usuarios > 0) {
      throw new BadRequestException({
        code: 'EMPRESA_CON_USUARIOS',
        message: `La empresa todavía tiene ${usuarios} usuario(s). Incluye usuarios dados de baja cuyo historial se conserva.`,
      });
    }
    await this.empresaRepository.delete(id);
    return { message: 'Empresa eliminada.' };
  }

  async createPlaya(empresaId: string, dto: CreatePlayaDto) {
    const empresa = await this.empresaRepository.findOne({
      where: { id: empresaId },
    });
    if (!empresa) throw new NotFoundException('Empresa no encontrada.');
    const playa = this.playaRepository.create({
      empresaId,
      nombre: dto.nombre.trim(),
      direccion: dto.direccion?.trim() || null,
    });
    return this.dataSource.transaction(async (manager) => {
      const saved = await manager.getRepository(Playa).save(playa);
      await manager.query(
        `INSERT INTO ticket_vehicle_types ("playaId", code, name, enabled) VALUES ($1, 'AUTO', 'Auto', true)`,
        [saved.id],
      );
      await manager.query(
        `INSERT INTO ticket_price_brackets ("playaId", "vehicleType", "ticketDayType", label, "uptoMinutes", price, "recurringUnitMinutes", "recurringPriceMode")
         VALUES
         ($1, 'AUTO', NULL, 'Ejemplo: hasta 30 minutos', 30, 1000, NULL, 'FIXED'),
         ($1, 'AUTO', NULL, 'Ejemplo: hasta 1 hora', 60, 2000, NULL, 'FIXED'),
         ($1, 'AUTO', NULL, 'Ejemplo: hasta 2 horas', 120, 4000, NULL, 'FIXED'),
         ($1, 'AUTO', NULL, 'Ejemplo: cada hora adicional', NULL, 2000, 60, 'FIXED')`,
        [saved.id],
      );
      return saved;
    });
  }

  async updatePlaya(id: string, dto: UpdatePlayaDto) {
    const playa = await this.playaRepository.findOne({ where: { id } });
    if (!playa) throw new NotFoundException('Playa no encontrada.');
    return this.playaRepository.save(this.playaRepository.merge(playa, dto));
  }

  // No se borra una playa que ya tiene operación cargada: las FK de tickets, caja y turnos no
  // tienen ON DELETE, así que Postgres lo rechazaría igual, pero con un error ilegible.
  async removePlaya(id: string) {
    const playa = await this.playaRepository.findOne({ where: { id } });
    if (!playa) throw new NotFoundException('Playa no encontrada.');

    const enUso = await this.contarOperacion(id);
    if (enUso > 0) {
      throw new BadRequestException({
        code: 'PLAYA_EN_USO',
        message: `La playa tiene ${enUso} registro(s) de operación (tickets, caja o turnos). No se puede borrar.`,
      });
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(UsuarioPlaya).delete({ playaId: id });
      await manager.query(
        'DELETE FROM ticket_vehicle_types WHERE "playaId"=$1',
        [id],
      );
      await manager.getRepository(Playa).delete(id);
    });
    // Devuelve a qué empresa pertenecía para que el controlador pueda auditar el borrado.
    return {
      message: 'Playa eliminada.',
      empresaId: playa.empresaId,
      nombre: playa.nombre,
    };
  }

  private async contarOperacion(playaId: string): Promise<number> {
    // Incluye también tarifas, cocheras y cualquier entidad futura vinculada a la playa.
    const entidades = this.dataSource.entityMetadatas.filter(
      (meta) =>
        meta.target !== UsuarioPlaya &&
        meta.tableName !== 'ticket_vehicle_types' &&
        meta.columns.some((c) => c.propertyName === 'playaId'),
    );
    let total = 0;
    for (const meta of entidades) {
      total += await this.dataSource
        .getRepository(meta.target)
        .count({ where: { playaId }, withDeleted: true });
    }
    return total;
  }

  // La lista completa de playas del usuario: lo que no venga en el dto se revoca. Se valida que
  // la playa sea de la misma empresa que el usuario, que es la regla que la base todavía no
  // puede garantizar sola.
  async asignarPlayas(usuarioId: string, dto: AsignarPlayasDto) {
    const usuario = await this.userRepository.findOne({
      where: { id: usuarioId },
    });
    if (!usuario) throw new NotFoundException('Usuario no encontrado.');
    if (usuario.role === 'USER' && dto.playaIds.length !== 1)
      throw new BadRequestException('Asigná una sola playa al operador.');
    if (!usuario.empresaId) {
      throw new BadRequestException(
        'El usuario no pertenece a ninguna empresa.',
      );
    }

    if (dto.playaIds.length > 0) {
      const playas = await this.playaRepository.find({
        where: { id: In(dto.playaIds) },
      });
      if (playas.length !== dto.playaIds.length)
        throw new NotFoundException('Alguna playa no existe.');
      const ajenas = playas.filter((p) => p.empresaId !== usuario.empresaId);
      if (ajenas.length > 0) {
        throw new BadRequestException({
          code: 'PLAYA_DE_OTRA_EMPRESA',
          message: 'No podés asignarle a un usuario una playa de otra empresa.',
        });
      }
    }

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(UsuarioPlaya);
      await repo.delete({ usuarioId });
      if (dto.playaIds.length === 0) return [];
      const filas = dto.playaIds.map((playaId) =>
        repo.create({
          usuarioId,
          playaId,
          rolPlaya: dto.rolPlaya ?? 'OPERADOR',
        }),
      );
      return repo.save(filas);
    });
  }

  // audit_log estaba creada y vacía: nadie escribía en ella. La administración de la plataforma
  // es lo primero que conviene registrar, porque son las acciones que nadie más puede deshacer
  // (suspender una empresa, borrar una playa, dar de alta un usuario).
  //
  // Nunca hace fallar la operación que audita: si el registro no se puede escribir, la acción ya
  // ocurrió y perderla sería peor que perder su rastro.
  async registrarAuditoria(entrada: {
    empresaId: string;
    usuarioId?: string | null;
    playaId?: string | null;
    accion: string;
    entidad: string;
    entidadId?: string | null;
  }) {
    try {
      await this.dataSource.getRepository(AuditLog).insert({
        empresaId: entrada.empresaId,
        usuarioId: entrada.usuarioId ?? null,
        playaId: entrada.playaId ?? null,
        accion: entrada.accion,
        entidad: entrada.entidad,
        entidadId: entrada.entidadId ?? null,
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo registrar la auditoría ${entrada.accion}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  async empresaDeUsuario(usuarioId: string) {
    const usuario = await this.userRepository.findOne({
      where: { id: usuarioId },
      withDeleted: true,
    });
    return usuario?.empresaId ?? null;
  }

  async actividadDeEmpresa(empresaId: string, limite = 40) {
    const filas = await this.dataSource.query(
      `SELECT a.accion, a.entidad, a."entidadId", a.fecha, a."playaId", a.detalle,
              u."firstName", u."lastName", p.nombre AS playa
       FROM audit_log a
       LEFT JOIN users u ON u.id = a."usuarioId"
       LEFT JOIN playas p ON p.id = a."playaId"
       WHERE a."empresaId" = $1
       ORDER BY a.fecha DESC
       LIMIT $2`,
      [empresaId, Math.min(Math.max(limite, 1), 200)],
    );
    return filas.map((f: any) => ({
      accion: f.accion,
      entidad: f.entidad,
      entidadId: f.entidadId,
      fecha: f.fecha,
      detalle: f.detalle ?? null,
      playa: f.playa ?? null,
      usuario:
        f.firstName || f.lastName
          ? `${f.firstName ?? ''} ${f.lastName ?? ''}`.trim()
          : null,
    }));
  }

  // La ficha de una empresa. Misma forma que un elemento de findAllEmpresas, para que la página
  // de detalle y el panel compartan tipos en el frontend.
  async findEmpresa(id: string) {
    const empresas = await this.findAllEmpresas();
    const empresa = empresas.find((e) => e.id === id);
    if (!empresa) throw new NotFoundException('Empresa no encontrada.');
    return empresa;
  }

  // Métricas de toda la plataforma, agregadas por playa: el front las suma por empresa y por
  // filtro. Son cuatro consultas agrupadas y no una por playa, porque el panel las pide en cada
  // carga y una plataforma con decenas de playas haría decenas de queries.
  //
  // No pasa por el TenantInterceptor (TenancyController está excluido), así que la conexión
  // conserva el rol dueño y ve todas las playas. Cualquier consulta que se agregue acá tiene que
  // seguir siendo de solo lectura.
  async metrics(dias: number) {
    const ventana = Math.min(Math.max(Math.trunc(dias) || 30, 1), 365);
    const desde = new Date(Date.now() - ventana * 24 * 60 * 60 * 1000);

    const [cobros, estadias, turnos, tarifas] = await Promise.all([
      // CORTESIA es una estadía bonificada: figura como movimiento pero no es plata cobrada.
      this.dataSource.query(
        `SELECT "playaId", COALESCE(SUM(monto), 0)::int AS cobrado, MAX("fechaHora") AS ultima
         FROM movimientos WHERE tipo <> 'CORTESIA' AND "fechaHora" >= $1 AND "playaId" IS NOT NULL
         GROUP BY "playaId"`,
        [desde],
      ),
      this.dataSource.query(
        `SELECT "playaId", COUNT(*)::int AS abiertas, MAX("createdAt") AS ultima
         FROM ticket_registrations WHERE "departureDay" IS NULL AND "playaId" IS NOT NULL
         GROUP BY "playaId"`,
      ),
      this.dataSource.query(
        `SELECT "playaId", COUNT(*)::int AS abiertos FROM turnos
         WHERE estado = 'ABIERTO' AND "playaId" IS NOT NULL GROUP BY "playaId"`,
      ),
      this.dataSource.query(
        `SELECT "playaId", COUNT(*)::int AS brackets FROM ticket_price_brackets
         WHERE "playaId" IS NOT NULL GROUP BY "playaId"`,
      ),
    ]);

    const playas = await this.playaRepository.find({
      order: { nombre: 'ASC' },
    });
    const porPlaya = (filas: any[], id: string) =>
      filas.find((f) => f.playaId === id);
    const masReciente = (a: Date | null, b: Date | null) =>
      !a ? b : !b ? a : a > b ? a : b;

    return {
      desde: desde.toISOString(),
      dias: ventana,
      playas: playas.map((playa) => {
        const cobro = porPlaya(cobros, playa.id);
        const estadia = porPlaya(estadias, playa.id);
        const ultima = masReciente(
          cobro?.ultima ? new Date(cobro.ultima) : null,
          estadia?.ultima ? new Date(estadia.ultima) : null,
        );
        return {
          playaId: playa.id,
          empresaId: playa.empresaId,
          nombre: playa.nombre,
          cobrado: cobro?.cobrado ?? 0,
          estadiasAbiertas: estadia?.abiertas ?? 0,
          turnosAbiertos: porPlaya(turnos, playa.id)?.abiertos ?? 0,
          // Sin franjas de precio no se puede registrar una entrada: es el aviso más útil del panel.
          tieneTarifas: (porPlaya(tarifas, playa.id)?.brackets ?? 0) > 0,
          ultimaOperacion: ultima ? ultima.toISOString() : null,
        };
      }),
    };
  }

  // El detalle que consume la pantalla de métricas: serie diaria contra el período anterior,
  // reparto por medio de pago y actividad por hora y día de la semana. Todo en horario de
  // Argentina, que es como lo lee el operador; `fechaHora` es timestamptz, así que la conversión
  // la hace Postgres y no hay que recalcular nada acá.
  async metricsDetalle(dias: number, empresaId?: string) {
    const ventana = Math.min(Math.max(Math.trunc(dias) || 30, 1), 365);
    const zona = 'America/Argentina/Buenos_Aires';
    const desde = new Date(Date.now() - ventana * 24 * 60 * 60 * 1000);
    const desdePrevio = new Date(
      Date.now() - ventana * 2 * 24 * 60 * 60 * 1000,
    );

    // Un filtro por empresa se resuelve con las playas de esa empresa: los movimientos no
    // guardan empresaId.
    const playas = await this.playaRepository.find(
      empresaId ? { where: { empresaId } } : {},
    );
    const ids = playas.map((p) => p.id);
    if (!ids.length)
      return {
        dias: ventana,
        serie: [],
        anterior: [],
        serieEstadias: [],
        metodos: [],
        empresas: [],
        horas: [],
        totales: { actual: 0, anterior: 0, estadias: 0, estadiasAnterior: 0 },
      };

    const [serie, metodos, horas, estadias, empresas, cierresDiarios] =
      await Promise.all([
        this.dataSource.query(
          `SELECT ("fechaHora" AT TIME ZONE $3)::date AS dia, COALESCE(SUM(monto), 0)::int AS total
         FROM movimientos
         WHERE tipo <> 'CORTESIA' AND "playaId" = ANY($1) AND "fechaHora" >= $2
         GROUP BY dia ORDER BY dia`,
          [ids, desdePrevio, zona],
        ),
        this.dataSource.query(
          `SELECT metodo, COALESCE(SUM(monto), 0)::int AS total
         FROM movimientos
         WHERE tipo <> 'CORTESIA' AND "playaId" = ANY($1) AND "fechaHora" >= $2
         GROUP BY metodo`,
          [ids, desde],
        ),
        this.dataSource.query(
          `SELECT EXTRACT(ISODOW FROM ("createdAt" AT TIME ZONE $3))::int AS dia,
                EXTRACT(HOUR FROM ("createdAt" AT TIME ZONE $3))::int AS hora,
                COUNT(*)::int AS entradas
         FROM ticket_registrations
         WHERE "playaId" = ANY($1) AND "createdAt" >= $2
         GROUP BY dia, hora`,
          [ids, desde, zona],
        ),
        // Estadías cerradas del período y del anterior en una sola pasada: el KPI muestra la
        // variación igual que el de cobrado, y sin la segunda cuenta no habría con qué comparar.
        this.dataSource.query(
          `SELECT COUNT(*) FILTER (WHERE "createdAt" >= $2)::int AS total,
                COUNT(*) FILTER (WHERE "createdAt" < $2)::int AS anterior
         FROM ticket_registrations
         WHERE "playaId" = ANY($1) AND "departureDay" IS NOT NULL AND "createdAt" >= $3`,
          [ids, desde, desdePrevio],
        ),
        // Comparativa por empresa: cobrado de este período y del anterior en una sola pasada, más
        // las estadías que efectivamente se cerraron.
        this.dataSource.query(
          `SELECT p."empresaId", e.nombre,
                COALESCE(SUM(m.monto) FILTER (WHERE m."fechaHora" >= $2), 0)::int AS cobrado,
                COALESCE(SUM(m.monto) FILTER (WHERE m."fechaHora" < $2), 0)::int AS anterior
         FROM movimientos m
         JOIN playas p ON p.id = m."playaId"
         JOIN empresas e ON e.id = p."empresaId"
         WHERE m.tipo <> 'CORTESIA' AND m."playaId" = ANY($1) AND m."fechaHora" >= $3
         GROUP BY p."empresaId", e.nombre
         ORDER BY cobrado DESC`,
          [ids, desde, desdePrevio],
        ),
        // Estadías cerradas por día: el sparkline del KPI dibuja su propia forma. Con la serie de
        // dinero dibujaba otra cosa con el rótulo equivocado.
        this.dataSource.query(
          `SELECT ("createdAt" AT TIME ZONE $3)::date AS dia, COUNT(*)::int AS total
         FROM ticket_registrations
         WHERE "playaId" = ANY($1) AND "departureDay" IS NOT NULL AND "createdAt" >= $2
         GROUP BY dia ORDER BY dia`,
          [ids, desde, zona],
        ),
      ]);

    const cerradasPorEmpresa = await this.dataSource.query(
      `SELECT p."empresaId", COUNT(*)::int AS estadias
       FROM ticket_registrations r
       JOIN playas p ON p.id = r."playaId"
       WHERE r."playaId" = ANY($1) AND r."departureDay" IS NOT NULL AND r."createdAt" >= $2
       GROUP BY p."empresaId"`,
      [ids, desde],
    );

    const corte = desde.toISOString().slice(0, 10);
    const dia = (f: any) => new Date(f.dia).toISOString().slice(0, 10);
    const actuales = serie.filter((f: any) => dia(f) >= corte);
    const previos = serie.filter((f: any) => dia(f) < corte);
    const sumar = (filas: any[]) =>
      filas.reduce((total, f) => total + Number(f.total), 0);

    return {
      dias: ventana,
      serie: actuales.map((f: any) => ({
        dia: dia(f),
        total: Number(f.total),
      })),
      anterior: previos.map((f: any) => ({
        dia: dia(f),
        total: Number(f.total),
      })),
      serieEstadias: cierresDiarios.map((f: any) => ({
        dia: dia(f),
        total: Number(f.total),
      })),
      metodos: metodos.map((f: any) => ({
        metodo: f.metodo,
        total: Number(f.total),
      })),
      // ISODOW: 1 = lunes … 7 = domingo.
      horas: horas.map((f: any) => ({
        dia: f.dia,
        hora: f.hora,
        entradas: f.entradas,
      })),
      empresas: empresas.map((e: any) => ({
        empresaId: e.empresaId,
        nombre: e.nombre,
        cobrado: Number(e.cobrado),
        anterior: Number(e.anterior),
        estadias: Number(
          cerradasPorEmpresa.find((c: any) => c.empresaId === e.empresaId)
            ?.estadias ?? 0,
        ),
      })),
      totales: {
        actual: sumar(actuales),
        anterior: sumar(previos),
        estadias: Number(estadias[0]?.total ?? 0),
        estadiasAnterior: Number(estadias[0]?.anterior ?? 0),
      },
    };
  }

  // Lo que el panel muestra ANTES de ofrecer el borrado: los mismos bloqueos que aplican
  // removeEmpresa y removePlaya, para que el operador vea por qué no puede en lugar de recibir
  // el rechazo después de confirmar.
  async resumenEliminacionEmpresa(id: string) {
    const empresa = await this.empresaRepository.findOne({
      where: { id },
      relations: ['playas'],
    });
    if (!empresa) throw new NotFoundException('Empresa no encontrada.');
    const playas = empresa.playas ?? [];
    const usuarios = await this.userRepository.count({
      where: { empresaId: id },
      withDeleted: true,
    });
    let registros = 0;
    for (const playa of playas)
      registros += await this.contarOperacion(playa.id);
    return {
      nombre: empresa.nombre,
      estado: empresa.estado,
      playas: playas.length,
      usuarios,
      registros,
      puedeEliminar: playas.length === 0 && usuarios === 0,
    };
  }

  async resumenEliminacionPlaya(id: string) {
    const playa = await this.playaRepository.findOne({ where: { id } });
    if (!playa) throw new NotFoundException('Playa no encontrada.');
    const registros = await this.contarOperacion(id);
    const usuarios = await this.usuarioPlayaRepository.count({
      where: { playaId: id },
    });
    return {
      nombre: playa.nombre,
      registros,
      usuarios,
      puedeEliminar: registros === 0,
    };
  }
}
