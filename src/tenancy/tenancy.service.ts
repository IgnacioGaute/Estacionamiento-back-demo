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
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { esGratuita, Modalidad } from './modalidad';
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
import { SuscripcionesService } from 'src/saas/suscripciones.service';

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
    private readonly suscripciones: SuscripcionesService,
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
  async findEmpresasPage(pagination: { page: number; limit: number }) {
    const [rows, total] = await this.empresaRepository.findAndCount({ select: { id: true, nombre: true }, order: { nombre: 'ASC', id: 'ASC' }, skip: (pagination.page - 1) * pagination.limit, take: pagination.limit });
    const data = rows.length ? await this.findAllEmpresas(rows.map(e => e.id)) : [];
    return { data, meta: { totalItems: total, currentPage: pagination.page, itemsPerPage: pagination.limit, totalPages: Math.ceil(total / pagination.limit) } };
  }

  async findAllEmpresas(ids?: string[]) {
    const empresas = await this.empresaRepository.find({
      relations: ['playas'],
      where: ids ? { id: In(ids) } : {},
      order: { nombre: 'ASC', id: 'ASC' },
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
    // Solo el estado y la fecha: los tokens de la cuenta nunca salen de su módulo.
    const cuentasMp: {
      empresaId: string;
      estado: string;
      conectadaEl: Date | null;
    }[] = await this.dataSource.query(
      `SELECT "empresaId", estado, "conectadaEl" FROM mercadopago_cuentas
       WHERE "empresaId" = ANY($1)`,
      [empresas.map((e) => e.id)],
    );
    // Plan, vencimiento y estado de la cuenta con la plataforma, en lote.
    const cuentas = await this.suscripciones.resumenes(empresas.map((e) => e.id));

    return empresas.map((empresa) => ({
      ...empresa,
      suscripcion: cuentas.get(empresa.id) ?? null,
      mercadoPago: (() => {
        const cuenta = cuentasMp.find((c) => c.empresaId === empresa.id);
        return cuenta
          ? {
              estado: cuenta.estado,
              conectadaEl: cuenta.conectadaEl
                ? new Date(cuenta.conectadaEl).toISOString()
                : null,
            }
          : null;
      })(),
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
      // Las tarifas las define el administrador antes del primer ingreso.
      // Los ejemplos no deben convertirse en importes reales de cobro.
      return saved;
    });
  }

  async updatePlaya(id: string, dto: UpdatePlayaDto) {
    const playa = await this.playaRepository.findOne({ where: { id } });
    if (!playa) throw new NotFoundException('Playa no encontrada.');
    const { modulos, ...datos } = dto;
    // Con plan asignado, las cocheras mensuales las define el plan: para prenderlas o apagarlas
    // se cambia el plan, que además cambia lo que paga.
    if (modulos?.inquilinos !== undefined) {
      const [linea] = await this.dataSource.query(
        `SELECT p."incluyeCocheras" FROM suscripcion_playas sp JOIN planes p ON p.id = sp."planId"
         WHERE sp."playaId" = $1`,
        [id],
      );
      if (linea && linea.incluyeCocheras !== modulos.inquilinos)
        throw new BadRequestException({
          code: 'MODULO_DEFINIDO_POR_PLAN',
          message: modulos.inquilinos
            ? 'El plan de esta playa no incluye cocheras mensuales. Cambiale el plan para habilitar Inquilinos.'
            : 'El plan de esta playa incluye cocheras mensuales. Cambiale el plan para quitar Inquilinos.',
        });
    }
    this.playaRepository.merge(playa, datos);
    // Se combinan: prender una sección no apaga las demás.
    if (modulos) playa.modulos = { ...(playa.modulos ?? {}), ...modulos };
    return this.playaRepository.save(playa);
  }

  /**
   * Qué impide o qué conviene saber antes de pasar la playa a `destino`. Se consulta con la conexión
   * de plataforma (sin RLS), así que todo filtra por playa explícitamente.
   *
   * Bloquean el paso a gratuita lo que después no podría cerrarse ni acreditarse de forma coherente:
   * turnos y cajas abiertos (la caja desaparece con plata adentro), estadías con cobro que siguen
   * adentro (habría que cobrarlas sin caja), abonos Día/Sem/Mes sin retirar y cobros por QR o alias
   * esperando el pago (la acreditación movería una caja que ya no existe). Nunca se resuelven solos:
   * no se cierran turnos, no se borra historia ni se crean ajustes para permitir el cambio.
   *
   * Los avisos no bloquean: saldos de inquilinos y recibos pendientes quedan registrados y
   * consultables (se pueden cobrar volviendo a «Con cobro»); una contingencia preparada que
   * sincronice después queda pendiente para revisión.
   */
  private async pendientesDeModalidad(manager: EntityManager, playaId: string, destino: Modalidad) {
    const contar = async (sql: string) => Number((await manager.query(sql, [playaId]))[0]?.n ?? 0);
    const bloqueos: { code: string; cantidad: number; mensaje: string }[] = [];
    const avisos: { code: string; cantidad: number; mensaje: string }[] = [];
    const agregar = (lista: typeof bloqueos, code: string, cantidad: number, mensaje: string) => {
      if (cantidad > 0) lista.push({ code, cantidad, mensaje });
    };
    if (destino === 'GRATUITO') {
      agregar(bloqueos, 'TURNOS_ABIERTOS', await contar(`SELECT count(*) AS n FROM turnos WHERE "playaId" = $1 AND estado = 'ABIERTO'`),
        'Turnos de caja abiertos: cada operador tiene que cerrar su turno (el último, con el arqueo) desde Caja → Turnos.');
      agregar(bloqueos, 'CAJAS_ABIERTAS', await contar(`SELECT count(*) AS n FROM cash_sessions WHERE "playaId" = $1 AND estado = 'ABIERTO'`),
        'Cajas físicas abiertas: hay que cerrarlas con su arqueo antes de dejar de cobrar.');
      agregar(bloqueos, 'ESTADIAS_CON_COBRO', await contar(`SELECT count(*) AS n FROM ticket_registrations WHERE "playaId" = $1 AND "departureTime" IS NULL AND modalidad = 'CON_COBRO'`),
        'Vehículos adentro que ingresaron con cobro: registrá su salida desde Cobrar salida (o esperá a que salgan).');
      agregar(bloqueos, 'ABONOS_SIN_RETIRAR', await contar(`SELECT count(*) AS n FROM ticket_registration_for_days WHERE "playaId" = $1 AND COALESCE(retired, false) = false`),
        'Estadías por día, semana o mes sin retirar: registrá su salida (y su cobro si falta) antes del cambio.');
      agregar(bloqueos, 'COBROS_PENDIENTES', await contar(
        `SELECT (SELECT count(*) FROM cobros_mercadopago WHERE "playaId" = $1 AND estado = 'PENDIENTE')
              + (SELECT count(*) FROM cobros_transferencia WHERE "playaId" = $1 AND estado IN ('ESPERANDO', 'REVISION')) AS n`),
        'Cobros por QR o al alias esperando el pago: esperá que se acrediten o cancelalos desde Cobrar salida.');
      agregar(avisos, 'SALDOS_INQUILINOS', await contar(
        `SELECT count(*) AS n FROM (SELECT "customerId" FROM cuenta_movimientos WHERE "playaId" = $1 GROUP BY "customerId" HAVING SUM(importe) <> 0) s`),
        'Inquilinos con saldo pendiente o a favor: quedan registrados y se pueden consultar, pero no se registran pagos mientras la playa sea gratuita.');
      agregar(avisos, 'RECIBOS_PENDIENTES', await contar(`SELECT count(*) AS n FROM receipts WHERE "playaId" = $1 AND status = 'PENDING' AND "deletedAt" IS NULL`),
        'Recibos de clientes mensuales pendientes: quedan como están, sin cobrarse mientras la playa sea gratuita.');
      agregar(avisos, 'CONTINGENCIAS_ACTIVAS', await contar(`SELECT count(*) AS n FROM offline_sessions WHERE "playaId" = $1 AND active = true AND "expiresAt" > now()`),
        'Equipos con el modo sin conexión preparado: confirmá que no tengan entradas o cobros sin sincronizar. Lo que sincronicen después del cambio queda pendiente para revisión, y para registrarlo hay que volver un momento a Con cobro.');
    } else {
      agregar(avisos, 'ESTADIAS_GRATUITAS', await contar(`SELECT count(*) AS n FROM ticket_registrations WHERE "playaId" = $1 AND "departureTime" IS NULL AND modalidad = 'GRATUITO'`),
        'Vehículos adentro que ingresaron gratis: van a salir sin cargo, con «Registrar salida».');
      agregar(avisos, 'TIPOS_SIN_TARIFA', await contar(
        `SELECT count(*) AS n FROM ticket_vehicle_types v WHERE v."playaId" = $1 AND v.enabled
           AND NOT EXISTS (SELECT 1 FROM ticket_price_brackets b WHERE b."playaId" = $1 AND b."vehicleType" = v.code)`),
        'Tipos de vehículo habilitados sin tarifas: sus ingresos se rechazan hasta que el administrador cargue Tarifas.');
    }
    return { bloqueos, avisos };
  }

  async previsualizarModalidad(playaId: string) {
    const playa = await this.playaRepository.findOne({ where: { id: playaId } });
    if (!playa) throw new NotFoundException('Playa no encontrada.');
    const modalidad: Modalidad = esGratuita(playa.modalidad) ? 'GRATUITO' : 'CON_COBRO';
    const destino: Modalidad = modalidad === 'GRATUITO' ? 'CON_COBRO' : 'GRATUITO';
    return { modalidad, destino, ...(await this.pendientesDeModalidad(this.dataSource.manager, playaId, destino)) };
  }

  /**
   * Cambia la modalidad de una playa. Toma exclusivos los bloqueos de tarifas (718903) y caja
   * (718904), en el mismo orden que la configuración y la contingencia: los ingresos (que leen la
   * modalidad con 718903) y toda operación de dinero (que la vuelve a leer con 718904) terminan
   * antes y el cambio los ve, o empiezan después y ven la modalidad nueva. Así un turno, un cobro o
   * un ingreso con cobro no se cuela después de verificar los pendientes. Las estadías ya
   * ingresadas conservan la suya.
   */
  async cambiarModalidad(playaId: string, destino: Modalidad) {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(718903)');
      await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const playa = await manager.getRepository(Playa).findOne({ where: { id: playaId }, lock: { mode: 'pessimistic_write' } });
      if (!playa) throw new NotFoundException('Playa no encontrada.');
      const anterior: Modalidad = esGratuita(playa.modalidad) ? 'GRATUITO' : 'CON_COBRO';
      const pendientes = await this.pendientesDeModalidad(manager, playaId, destino);
      if (anterior === destino) return { playa, anterior, cambio: false, ...pendientes };
      if (pendientes.bloqueos.length)
        throw new ConflictException({
          code: 'MODALIDAD_CON_PENDIENTES',
          message: `No se puede pasar «${playa.nombre}» a modalidad gratuita todavía: ${pendientes.bloqueos.map((b) => b.mensaje).join(' ')}`,
          bloqueos: pendientes.bloqueos,
        });
      await manager.getRepository(Playa).update({ id: playaId }, { modalidad: destino });
      playa.modalidad = destino;
      return { playa, anterior, cambio: true, ...pendientes };
    });
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
        // La auditoría tampoco es operación: crear o renombrar la playa ya deja filas, y contarlas
        // hacía imposible borrar cualquier playa. Se conserva (no tiene FK a playas) como historial.
        meta.target !== AuditLog &&
        meta.tableName !== 'ticket_vehicle_types' &&
        // El plan de la playa es configuración, no operación: se borra con ella (ON DELETE CASCADE).
        meta.tableName !== 'suscripcion_playas' &&
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
    const empresas = await this.findAllEmpresas([id]);
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

    const [cobros, estadias, turnos, tarifas, comprobantes] = await Promise.all([
      // CORTESIA es una estadía bonificada: figura como movimiento pero no es plata cobrada.
      this.dataSource.query(
        `SELECT "playaId", COALESCE(SUM(monto), 0)::int AS cobrado, MAX("fechaHora") AS ultima
         FROM movimientos WHERE tipo NOT IN ('CORTESIA', 'DESCUENTO') AND "fechaHora" >= $1 AND "playaId" IS NOT NULL
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
      // Canales de comprobante por playa: la ficha avisa cuáles todavía entregan solo en papel.
      this.dataSource.query(
        `SELECT "playaId", "receiptDelivery" FROM ticket_schedule_settings
         WHERE "playaId" IS NOT NULL`,
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
        const entrega = porPlaya(comprobantes, playa.id)?.receiptDelivery;
        return {
          playaId: playa.id,
          empresaId: playa.empresaId,
          nombre: playa.nombre,
          cobrado: cobro?.cobrado ?? 0,
          estadiasAbiertas: estadia?.abiertas ?? 0,
          turnosAbiertos: porPlaya(turnos, playa.id)?.abiertos ?? 0,
          // Sin franjas de precio no se puede registrar una entrada: es el aviso más útil del panel.
          // Una playa gratuita no las necesita (sus ingresos no capturan tarifas): no se avisa.
          tieneTarifas: esGratuita(playa.modalidad) || (porPlaya(tarifas, playa.id)?.brackets ?? 0) > 0,
          modalidad: esGratuita(playa.modalidad) ? 'GRATUITO' : 'CON_COBRO',
          ultimaOperacion: ultima ? ultima.toISOString() : null,
          comprobantes: {
            whatsapp: !!entrega?.whatsapp,
            qr: !!entrega?.qr,
            print: !!entrega?.print,
          },
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
        serieEstadiasAnterior: [],
        seriePlayas: [],
        metodos: [],
        metodosAnterior: [],
        abiertas24h: [],
        entradas: [],
        salidas: [],
        abonos: [],
        asistente: { temas: [], recientes: [], frecuentes: [] },
        empresas: [],
        horas: [],
        totales: { actual: 0, anterior: 0, estadias: 0, estadiasAnterior: 0 },
        origenes: [],
      };

    const [
      serie,
      metodos,
      horas,
      estadias,
      empresas,
      cierresDiarios,
      metodosAnterior,
      porPlaya,
      abiertas24h,
    ] = await Promise.all([
        this.dataSource.query(
          `SELECT ("fechaHora" AT TIME ZONE $3)::date AS dia, COALESCE(SUM(monto), 0)::int AS total
         FROM movimientos
         WHERE tipo NOT IN ('CORTESIA', 'DESCUENTO') AND "playaId" = ANY($1) AND "fechaHora" >= $2
         GROUP BY dia ORDER BY dia`,
          [ids, desdePrevio, zona],
        ),
        this.dataSource.query(
          `SELECT metodo, COALESCE(SUM(monto), 0)::int AS total
         FROM movimientos
         WHERE tipo NOT IN ('CORTESIA', 'DESCUENTO') AND "playaId" = ANY($1) AND "fechaHora" >= $2
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
         WHERE m.tipo NOT IN ('CORTESIA', 'DESCUENTO') AND m."playaId" = ANY($1) AND m."fechaHora" >= $3
         GROUP BY p."empresaId", e.nombre
         ORDER BY cobrado DESC`,
          [ids, desde, desdePrevio],
        ),
        // Estadías cerradas por día: el sparkline del KPI dibuja su propia forma. Con la serie de
        // dinero dibujaba otra cosa con el rótulo equivocado. Arranca en el período anterior
        // para poder comparar las estadías por día de la semana.
        this.dataSource.query(
          `SELECT ("createdAt" AT TIME ZONE $3)::date AS dia, COUNT(*)::int AS total
         FROM ticket_registrations
         WHERE "playaId" = ANY($1) AND "departureDay" IS NOT NULL AND "createdAt" >= $2
         GROUP BY dia ORDER BY dia`,
          [ids, desdePrevio, zona],
        ),
        // El reparto del período anterior, para medir cuánto creció el cobro con QR.
        this.dataSource.query(
          `SELECT metodo, COALESCE(SUM(monto), 0)::int AS total
         FROM movimientos
         WHERE tipo NOT IN ('CORTESIA', 'DESCUENTO') AND "playaId" = ANY($1) AND "fechaHora" >= $2 AND "fechaHora" < $3
         GROUP BY metodo`,
          [ids, desdePrevio, desde],
        ),
        // Cobrado por playa y por día: la ficha filtra la curva por playa y la comparativa suma
        // la tendencia de cada empresa con sus playas.
        this.dataSource.query(
          `SELECT "playaId", ("fechaHora" AT TIME ZONE $3)::date AS dia, COALESCE(SUM(monto), 0)::int AS total
         FROM movimientos
         WHERE tipo NOT IN ('CORTESIA', 'DESCUENTO') AND "playaId" = ANY($1) AND "fechaHora" >= $2
         GROUP BY "playaId", dia ORDER BY dia`,
          [ids, desde, zona],
        ),
        // Estadías abiertas hora por hora en las últimas 24 horas. Primero se acotan las
        // candidatas (abiertas, o cerradas hace menos de dos días) para no cruzar toda la
        // historia contra las 24 horas. La salida se guarda en fecha y hora de Argentina, así
        // que se recompone igual que en minutesSinceEntry.
        this.dataSource.query(
          `WITH candidatas AS (
             SELECT "createdAt" AS desde,
                    CASE WHEN "departureDay" IS NULL THEN NULL
                         ELSE ("departureDay" + COALESCE("departureTime", '00:00'::time)) AT TIME ZONE $2
                    END AS hasta
             FROM ticket_registrations
             WHERE "playaId" = ANY($1)
               AND ("departureDay" IS NULL OR "departureDay" >= (now() AT TIME ZONE $2)::date - 2)
           )
           SELECT h AS hora, COUNT(c.desde)::int AS abiertas
           FROM generate_series(now() - interval '23 hours', now(), interval '1 hour') AS h
           LEFT JOIN candidatas c ON c.desde <= h AND (c.hasta IS NULL OR c.hasta > h)
           GROUP BY h ORDER BY h`,
          [ids, zona],
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

    const [
      entradasDiarias,
      salidasDiarias,
      abonos,
      temasAsistente,
      recientesAsistente,
      frecuentesAsistente,
    ] = await Promise.all([
      // Movimiento de vehículos: las entradas cuentan el día en que se abrió la estadía y las
      // salidas el día en que se cerró. No es lo mismo que «estadías cerradas», que agrupa por
      // la entrada: un auto que entró el 30 y salió el 1 es salida del 1.
      this.dataSource.query(
        `SELECT ("createdAt" AT TIME ZONE $3)::date AS dia, COUNT(*)::int AS total
         FROM ticket_registrations
         WHERE "playaId" = ANY($1) AND "createdAt" >= $2
         GROUP BY dia ORDER BY dia`,
        [ids, desdePrevio, zona],
      ),
      this.dataSource.query(
        `SELECT "departureDay" AS dia, COUNT(*)::int AS total
         FROM ticket_registrations
         WHERE "playaId" = ANY($1) AND "departureDay" >= ($2::timestamptz AT TIME ZONE $3)::date
         GROUP BY "departureDay" ORDER BY "departureDay"`,
        [ids, desdePrevio, zona],
      ),
      // Estadías por día, semana o mes. «Semana y día» cuenta como semana y «mes y día» como
      // mes; las viejas sin tipo se clasifican por el campo que tengan cargado. Vigente es lo
      // que el panel del operador todavía muestra: no retirado.
      this.dataSource.query(
        `SELECT CASE
                  WHEN "ticketTimeType" IN ('MES', 'MES_Y_DIA') OR COALESCE(months, 0) > 0 THEN 'MES'
                  WHEN "ticketTimeType" IN ('SEMANA', 'SEMANA_Y_DIA') OR COALESCE(weeks, 0) > 0 THEN 'SEMANA'
                  ELSE 'DIA'
                END AS tipo,
                COUNT(*) FILTER (WHERE "createdAt" >= $2)::int AS vendidos,
                COUNT(*) FILTER (WHERE "createdAt" >= $3 AND "createdAt" < $2)::int AS anteriores,
                COALESCE(SUM(price) FILTER (WHERE "createdAt" >= $2), 0)::int AS importe,
                COUNT(*) FILTER (WHERE "createdAt" >= $2 AND NOT COALESCE(paid, false))::int AS pendientes,
                COUNT(*) FILTER (WHERE NOT COALESCE(retired, false))::int AS vigentes
         FROM ticket_registration_for_days
         WHERE "playaId" = ANY($1) AND ("createdAt" >= $3 OR NOT COALESCE(retired, false))
         GROUP BY tipo`,
        [ids, desde, desdePrevio],
      ),
      // Lo que le preguntan al asistente: temas, las últimas y las que se repiten.
      this.dataSource.query(
        `SELECT tema,
                COUNT(*) FILTER (WHERE "createdAt" >= $2)::int AS total,
                COUNT(*) FILTER (WHERE "createdAt" < $2)::int AS anterior,
                COUNT(*) FILTER (WHERE "createdAt" >= $2 AND NOT respondida)::int AS "sinRespuesta"
         FROM assistant_preguntas
         WHERE "playaId" = ANY($1) AND "createdAt" >= $3
         GROUP BY tema`,
        [ids, desde, desdePrevio],
      ),
      this.dataSource.query(
        `SELECT a.pregunta, a.tema, a.respondida, a."createdAt" AS fecha,
                p.nombre AS playa, e.nombre AS empresa
         FROM assistant_preguntas a
         JOIN playas p ON p.id = a."playaId"
         JOIN empresas e ON e.id = p."empresaId"
         WHERE a."playaId" = ANY($1) AND a."createdAt" >= $2
         ORDER BY a."createdAt" DESC LIMIT 6`,
        [ids, desde],
      ),
      this.dataSource.query(
        `SELECT (array_agg(pregunta ORDER BY "createdAt" DESC))[1] AS pregunta,
                MIN(tema) AS tema, COUNT(*)::int AS veces, MAX("createdAt") AS ultima
         FROM assistant_preguntas
         WHERE "playaId" = ANY($1) AND "createdAt" >= $2
         GROUP BY clave HAVING COUNT(*) > 1
         ORDER BY veces DESC, ultima DESC LIMIT 5`,
        [ids, desde],
      ),
    ]);

    // Cómo se cargaron las entradas y las salidas del período, por playa: escáner de patentes,
    // escáner corrigiendo la lectura, a mano o tarjeta. Las salidas por su día de salida (Argentina).
    // Lo anterior a medirlo cuenta como SIN_DATO.
    const origenesFilas: { playaId: string; tipo: 'entrada' | 'salida'; origen: string; n: number }[] =
      await this.dataSource.query(
        `SELECT "playaId", 'entrada' AS tipo, COALESCE("origenEntrada", 'SIN_DATO') AS origen, COUNT(*)::int AS n
         FROM ticket_registrations
         WHERE "playaId" = ANY($1) AND "createdAt" >= $2
         GROUP BY 1, 3
         UNION ALL
         SELECT "playaId", 'salida' AS tipo, COALESCE("origenSalida", 'SIN_DATO') AS origen, COUNT(*)::int AS n
         FROM ticket_registrations
         WHERE "playaId" = ANY($1) AND "departureDay" IS NOT NULL
           AND "departureDay"::date >= ($2::timestamptz AT TIME ZONE $3)::date
         GROUP BY 1, 3`,
        [ids, desde, zona],
      );
    const vacio = () => ({ ESCANER: 0, CORREGIDA: 0, MANUAL: 0, TARJETA: 0, SIN_DATO: 0 });
    const origenes = new Map<string, { playaId: string; playa: string; empresaId: string; entradas: Record<string, number>; salidas: Record<string, number> }>();
    for (const f of origenesFilas) {
      const playa = playas.find((p) => p.id === f.playaId);
      if (!playa) continue;
      const fila = origenes.get(f.playaId) ?? { playaId: f.playaId, playa: playa.nombre, empresaId: playa.empresaId, entradas: vacio(), salidas: vacio() };
      const destino = f.tipo === 'entrada' ? fila.entradas : fila.salidas;
      const origen = f.origen in destino ? f.origen : 'SIN_DATO';
      destino[origen] += Number(f.n);
      origenes.set(f.playaId, fila);
    }

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
      serieEstadias: cierresDiarios
        .filter((f: any) => dia(f) >= corte)
        .map((f: any) => ({ dia: dia(f), total: Number(f.total) })),
      serieEstadiasAnterior: cierresDiarios
        .filter((f: any) => dia(f) < corte)
        .map((f: any) => ({ dia: dia(f), total: Number(f.total) })),
      seriePlayas: porPlaya.map((f: any) => ({
        playaId: f.playaId,
        dia: dia(f),
        total: Number(f.total),
      })),
      metodos: metodos.map((f: any) => ({
        metodo: f.metodo,
        total: Number(f.total),
      })),
      metodosAnterior: metodosAnterior.map((f: any) => ({
        metodo: f.metodo,
        total: Number(f.total),
      })),
      abiertas24h: abiertas24h.map((f: any) => ({
        hora: new Date(f.hora).toISOString(),
        abiertas: Number(f.abiertas),
      })),
      // Desde el período anterior, con sus propias fechas: el front las superpone como `serie`.
      entradas: entradasDiarias.map((f: any) => ({ dia: dia(f), total: Number(f.total) })),
      salidas: salidasDiarias.map((f: any) => ({ dia: dia(f), total: Number(f.total) })),
      abonos: abonos.map((f: any) => ({
        tipo: f.tipo,
        vendidos: Number(f.vendidos),
        anteriores: Number(f.anteriores),
        importe: Number(f.importe),
        pendientes: Number(f.pendientes),
        vigentes: Number(f.vigentes),
      })),
      asistente: {
        temas: temasAsistente.map((f: any) => ({
          tema: f.tema,
          total: Number(f.total),
          anterior: Number(f.anterior),
          sinRespuesta: Number(f.sinRespuesta),
        })),
        recientes: recientesAsistente.map((f: any) => ({
          pregunta: f.pregunta,
          tema: f.tema,
          respondida: f.respondida,
          fecha: new Date(f.fecha).toISOString(),
          playa: f.playa,
          empresa: f.empresa,
        })),
        frecuentes: frecuentesAsistente.map((f: any) => ({
          pregunta: f.pregunta,
          tema: f.tema,
          veces: Number(f.veces),
        })),
      },
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
      origenes: [...origenes.values()],
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
