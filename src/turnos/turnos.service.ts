import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Not, Repository } from 'typeorm';
import { CashRegister } from './entities/cash-register.entity';
import { CashSession } from './entities/cash-session.entity';
import { CashSessionMovement } from './entities/cash-session-movement.entity';
import { CajaDto, CashSessionMovementDto } from './dto/caja.dto';
import { Turno } from './entities/turno.entity';
import { TicketScheduleSettings } from 'src/tickets/entities/ticket-schedule-settings.entity';
import { CashEntry } from './entities/cash-entry.entity';
import { Movimiento } from 'src/movimientos/entities/movimiento.entity';
import { OpenTurnoDto } from './dto/open-turno.dto';
import { CloseTurnoDto } from './dto/close-turno.dto';
import { User, UserRole } from 'src/users/entities/user.entity';
import { tenantContext } from 'src/tenancy/tenant-context';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

@Injectable()
export class TurnosService {
  constructor(
    @InjectRepository(Turno) private readonly turnoRepository: Repository<Turno>,
    @InjectRepository(Movimiento) private readonly movimientoRepository: Repository<Movimiento>,
    private readonly dataSource: DataSource,
  ) {}

  async findOpenTurnoOrNull(usuarioId: string, manager?: EntityManager): Promise<Turno | null> {
    // Mismo orden de locks que cobros y cierre: libro de caja, luego turno del operador.
    if (manager) await manager.query('SELECT pg_advisory_xact_lock(718904)');
    const repository = (manager ?? this.dataSource.manager).getRepository(Turno);
    return repository.findOne({ where: { usuarioApertura: { id: usuarioId }, estado: 'ABIERTO' }, ...(manager ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
  }

  async getOpenTurno(usuarioId: string) {
    const turno = await this.findOpenTurnoOrNull(usuarioId);
    if (!turno) throw new NotFoundException({ code: 'NO_OPEN_TURNO', message: 'No hay un turno de caja abierto.' });
    return turno;
  }

  private async cashTotal(turno: Turno, manager: EntityManager) {
    if (turno.cashSessionId) return this.sessionTotal(turno.cashSessionId, manager);
    if (turno.cashVersion === 2) {
      const row = await manager.getRepository(CashEntry).createQueryBuilder('c')
        .select('COALESCE(SUM(c.amount), 0)', 'sum').where('c.turnoId = :id', { id: turno.id }).getRawOne();
      return turno.fondoInicial + Number(row.sum);
    }
    const row = await manager.getRepository(Movimiento).createQueryBuilder('m')
      .select('COALESCE(SUM(m.monto), 0)', 'sum').where('m.turnoId = :id', { id: turno.id })
      .andWhere("m.metodo = 'CASH' AND m.tipo != 'CORTESIA'").getRawOne();
    return turno.fondoInicial + Number(row.sum);
  }

  private async ensureCajas(manager: EntityManager) {
    const repo = manager.getRepository(CashRegister);
    if (!await repo.exists({ where: { principal: true } })) await repo.save(repo.create({ nombre: 'Caja principal', principal: true, activa: true }));
    return repo.find({ order: { principal: 'DESC', createdAt: 'ASC' } });
  }

  private async sessionTotal(id: string, manager: EntityManager) {
    const session = await manager.getRepository(CashSession).findOneBy({ id });
    if (!session) throw new NotFoundException('Sesión de caja no encontrada.');
    const cash = await manager.getRepository(CashEntry).createQueryBuilder('c')
      .innerJoin(Turno, 't', 't.id = c.turnoId').where('t.cashSessionId = :id', { id })
      .select('COALESCE(SUM(c.amount), 0)', 'sum').getRawOne();
    const changes = await manager.getRepository(CashSessionMovement).createQueryBuilder('m')
      .where('m.sesionId = :id', { id }).select('COALESCE(SUM(m.amount), 0)', 'sum').getRawOne();
    return session.fondoInicial + Number(cash.sum) + Number(changes.sum);
  }

  private async cajaContext(caja: CashRegister, manager: EntityManager) {
    const repo = manager.getRepository(CashSession);
    const session = await repo.findOne({ where: { cajaId: caja.id, estado: 'ABIERTO' } });
    const last = await repo.findOne({ where: { cajaId: caja.id, estado: 'CERRADO' }, order: { fechaCierre: 'DESC', id: 'DESC' } });
    // Transición: sólo la primera apertura de Caja principal puede recibir el último fondo
    // del esquema anterior. Nunca se suman los fondos de cierres de distintos usuarios.
    const legacy = caja.principal && !session && !last
      ? await manager.getRepository(Turno).findOne({ where: { cashSessionId: IsNull(), estado: 'CERRADO', efectivoParaSiguiente: Not(IsNull()), recibidoPorTurnoId: IsNull() }, order: { fechaCierre: 'DESC', id: 'DESC' } }) : null;
    const users = session ? await manager.getRepository(Turno).find({ where: { cashSessionId: session.id, estado: 'ABIERTO' }, relations: ['usuarioApertura'], order: { fechaApertura: 'ASC' } }) : [];
    const movements = session ? await manager.getRepository(CashSessionMovement).find({ where: { sesionId: session.id }, relations: ['usuario'], order: { createdAt: 'DESC' } }) : [];
    return { ...caja, session, pending: last, legacyPending: legacy,
      movimientos: movements.map(m => ({ id: m.id, amount: m.amount, tipo: m.tipo, motivo: m.motivo, operador: m.usuario ? [m.usuario.firstName, m.usuario.lastName].join(' ').trim() : 'Usuario no disponible' })),
      efectivoDisponible: session ? await this.sessionTotal(session.id, manager) : last?.efectivoParaSiguiente ?? legacy?.efectivoParaSiguiente ?? 0,
      operadores: users.map(t => ({ turnoId: t.id, id: t.usuarioApertura?.id, nombre: t.nombre })),
    };
  }

  private async turnoContext(turno: Turno, manager: EntityManager) {
    const others = turno.cashSessionId ? await manager.getRepository(Turno).count({ where: { cashSessionId: turno.cashSessionId, estado: 'ABIERTO' } }) : 1;
    const net = await manager.getRepository(CashEntry).createQueryBuilder('c').where('c.turnoId = :id', { id: turno.id }).select('COALESCE(SUM(c.amount), 0)', 'sum').getRawOne();
    return { ...turno, efectivoDisponible: await this.cashTotal(turno, manager), efectivoOperado: Number(net.sum), usuariosEnCaja: others, requiereArqueo: others === 1 };
  }

  async getCashContext(usuarioId = tenantContext.getStore()?.userId) {
    if (!usuarioId) throw new UnauthorizedException('Esta acción requiere un usuario autenticado.');
    return this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const settings = await manager.getRepository(TicketScheduleSettings).findOne({ where: {} });
      const registers = await this.ensureCajas(manager);
      const cajas = await Promise.all(registers.filter(c => c.activa && (settings?.multipleShiftsEnabled || c.principal)).map(c => this.cajaContext(c, manager)));
      const repo = manager.getRepository(Turno);
      const own = await repo.findOne({ where: { usuarioApertura: { id: usuarioId }, estado: 'ABIERTO' }, relations: ['usuarioApertura', 'caja'] });
      const active = own ? await this.turnoContext(own, manager) : null;
      const abiertos = tenantContext.getStore()?.role === 'ADMIN'
        ? await repo.find({ where: { estado: 'ABIERTO' }, relations: ['usuarioApertura', 'caja'], order: { fechaApertura: 'ASC' } }) : [];
      const openTurnos = await Promise.all(abiertos.map(t => this.turnoContext(t, manager)));
      const legacyOpen = await repo.exists({ where: { estado: 'ABIERTO', cashSessionId: IsNull() } });
      const main = cajas.find(c => c.principal);
      const pending = main?.pending ? await repo.findOne({ where: { cashSessionId: main.pending.id, cierreCaja: true } }) : main?.legacyPending ?? null;
      return { active, pending, efectivoDisponible: active?.efectivoDisponible ?? cajas[0]?.efectivoDisponible ?? 0, openTurnos, cajas, multipleShiftsEnabled: settings?.multipleShiftsEnabled === true, legacyOpen };
    });
  }

  async getConfiguration() {
    return this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const cajas = await this.ensureCajas(manager);
      return { cajas, hayTurnosAbiertos: await manager.getRepository(Turno).exists({ where: { estado: 'ABIERTO' } }) };
    });
  }

  async saveCaja(dto: CajaDto, id?: string) {
    return this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const repo = manager.getRepository(CashRegister);
      const cajas = await this.ensureCajas(manager);
      const caja = id ? await repo.findOneBy({ id }) : repo.create({ principal: false, activa: true });
      if (!caja) throw new NotFoundException('Caja no encontrada.');
      const nombre = dto.nombre.trim();
      if (!nombre) throw new BadRequestException('Escribí el nombre de la caja.');
      if (cajas.some(c => c.id !== id && c.nombre.toLocaleLowerCase() === nombre.toLocaleLowerCase())) throw new ConflictException('Ya existe una caja con ese nombre.');
      if (dto.activa === false && id) {
        if (caja.principal) throw new BadRequestException('La caja principal debe permanecer disponible.');
        if (await manager.getRepository(CashSession).exists({ where: { cajaId: id, estado: 'ABIERTO' } })) throw new ConflictException('Cerrá la caja antes de desactivarla.');
        const last = await manager.getRepository(CashSession).findOne({ where: { cajaId: id, estado: 'CERRADO' }, order: { fechaCierre: 'DESC' } });
        if ((last?.efectivoParaSiguiente ?? 0) > 0) throw new ConflictException('La caja tiene efectivo pendiente. Retiralo al cerrar antes de desactivarla.');
      }
      Object.assign(caja, { nombre, activa: dto.activa ?? caja.activa });
      return repo.save(caja);
    });
  }

  async addCashMovement(sesionId: string, usuarioId: string, dto: CashSessionMovementDto, rol?: UserRole) {
    return this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const session = await manager.getRepository(CashSession).findOneBy({ id: sesionId, estado: 'ABIERTO' });
      if (!session) throw new ConflictException('La caja ya está cerrada.');
      if (rol !== 'ADMIN' && !await manager.getRepository(Turno).exists({ where: { cashSessionId: sesionId, usuarioApertura: { id: usuarioId }, estado: 'ABIERTO' } })) throw new ForbiddenException('Sólo podés mover efectivo de la caja de tu turno.');
      const expected = await this.sessionTotal(sesionId, manager);
      if (dto.efectivoEsperado !== expected) throw new ConflictException('El efectivo cambió. Actualizá la caja antes de registrar el movimiento.');
      if (!dto.motivo.trim()) throw new BadRequestException('Indicá el motivo del movimiento.');
      if (dto.tipo === 'RETIRO' && dto.importe > expected) throw new BadRequestException('No podés retirar más efectivo del disponible.');
      return manager.getRepository(CashSessionMovement).save({ sesionId, usuarioId, tipo: dto.tipo, amount: dto.tipo === 'RETIRO' ? -dto.importe : dto.importe, motivo: dto.motivo.trim() });
    });
  }

  async open(usuarioId: string, dto: OpenTurnoDto): Promise<Turno> {
    return this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const repo = manager.getRepository(Turno);
      if (await repo.exists({ where: { usuarioApertura: { id: usuarioId }, estado: 'ABIERTO' } })) throw new ConflictException('Ya tenés un turno abierto. Cerralo antes de abrir otro.');
      const settings = await manager.getRepository(TicketScheduleSettings).findOne({ where: {} });
      if (!settings?.shiftsEnabled) throw new BadRequestException('Los turnos están desactivados. El administrador puede activarlos en Configuración.');
      if (await repo.exists({ where: { cashSessionId: IsNull(), estado: 'ABIERTO' } })) throw new ConflictException('Cerrá los turnos del esquema anterior antes de abrir una caja nueva.');
      if (!settings.multipleShiftsEnabled && await repo.exists({ where: { estado: 'ABIERTO' } })) throw new ConflictException('Ya hay un turno abierto. Para trabajar al mismo tiempo, activá Turnos múltiples en Configuración.');
      const cajas = (await this.ensureCajas(manager)).filter(c => c.activa && (settings.multipleShiftsEnabled || c.principal));
      const caja = dto.cajaId ? cajas.find(c => c.id === dto.cajaId) : cajas.length === 1 ? cajas[0] : null;
      if (!caja) throw new BadRequestException('Elegí una caja habilitada para abrir tu turno.');
      const ctx = await this.cajaContext(caja, manager);
      const sessions = manager.getRepository(CashSession);
      let session = ctx.session;
      if (session) {
        if (!settings.multipleShiftsEnabled) throw new ConflictException('Esta caja ya tiene un turno abierto.');
        if (dto.sesionActivaId !== session.id) throw new ConflictException('La caja cambió. Actualizá y confirmá que te unís a la caja abierta.');
        if (dto.fondoInicial !== 0 || (dto.cambioAgregado ?? 0) !== 0) throw new BadRequestException('El fondo ya está en la caja compartida. No lo cargues otra vez.');
      } else {
        if (dto.sesionActivaId) throw new ConflictException('La caja ya cerró. Actualizá y contá el efectivo recibido.');
        const previousTurn = ctx.pending ? await repo.findOne({ where: { cashSessionId: ctx.pending.id, cierreCaja: true }, order: { fechaCierre: 'DESC' } }) : ctx.legacyPending;
        if (ctx.pending && dto.sesionAnteriorId !== ctx.pending.id && dto.turnoAnteriorId !== previousTurn?.id) throw new ConflictException('El fondo de esta caja cambió. Actualizá la apertura.');
        if (!ctx.pending && dto.sesionAnteriorId) throw new ConflictException('El fondo de esta caja cambió. Actualizá la apertura.');
        if (dto.turnoAnteriorId && dto.turnoAnteriorId !== previousTurn?.id) throw new ConflictException('El fondo pertenece a otro cierre de caja.');
        if (ctx.legacyPending && dto.turnoAnteriorId !== ctx.legacyPending.id) throw new ConflictException('Confirmá el fondo pendiente de la caja anterior.');
        const added = dto.cambioAgregado ?? 0;
        if (dto.fondoInicial < added) throw new BadRequestException('El fondo inicial debe incluir el cambio agregado.');
        const expected = ctx.pending?.efectivoParaSiguiente ?? ctx.legacyPending?.efectivoParaSiguiente ?? 0;
        const difference = ctx.pending || ctx.legacyPending ? expected - (dto.fondoInicial - added) : 0;
        if (difference !== 0 && !dto.motivoApertura?.trim()) throw new BadRequestException('Explicá la diferencia entre el fondo esperado y el recibido.');
        session = await sessions.save(sessions.create({ cajaId: caja.id, fondoInicial: dto.fondoInicial, fondoEsperado: expected, cambioAgregado: added, diferenciaApertura: difference, motivoApertura: dto.motivoApertura?.trim() || null, sesionAnteriorId: ctx.pending?.id ?? null, estado: 'ABIERTO' }));
      }
      const operator = await manager.getRepository(User).findOneBy({ id: usuarioId });
      if (!operator) throw new NotFoundException('Operador no encontrado.');
      const turno = await repo.save(repo.create({ usuarioApertura: { id: usuarioId }, cajaId: caja.id, cashSessionId: session.id,
        fondoInicial: ctx.session ? 0 : dto.fondoInicial, nombre: [operator.firstName, operator.lastName].join(' ').trim() || operator.username,
        duracionPrevistaHoras: null, cashVersion: 2, estado: 'ABIERTO', fondoRecibido: ctx.session ? 0 : dto.fondoInicial - (dto.cambioAgregado ?? 0),
        turnoAnteriorId: ctx.session ? null : dto.turnoAnteriorId ?? ctx.legacyPending?.id ?? null }));
      if (ctx.legacyPending) await repo.update(ctx.legacyPending.id, { recibidoPorTurnoId: turno.id });
      if (dto.turnoAnteriorId && ctx.pending) await repo.update(dto.turnoAnteriorId, { recibidoPorTurnoId: turno.id });
      return turno;
    });
  }

  async close(id: string, usuarioId: string, dto: CloseTurnoDto, rol?: UserRole): Promise<Turno> {
    return this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const repo = manager.getRepository(Turno);
      const turno = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!turno) throw new NotFoundException('Turno no encontrado.');
      const owner = await repo.findOne({ where: { id }, relations: ['usuarioApertura'] });
      // El usuario histórico puede estar dado de baja o fuera del alcance de la empresa.
      // El administrador debe poder cerrar el turno dejando el motivo registrado.
      const esResponsable = owner?.usuarioApertura?.id === usuarioId;
      const forzado = !esResponsable;
      if (forzado && rol !== 'ADMIN') {
        throw new ForbiddenException('El cierre debe confirmarlo el operador responsable del turno, o un administrador.');
      }
      // Un cierre ajeno siempre deja escrito por qué, para que el arqueo del operador que no
      // estuvo presente se pueda leer después sin adivinar quién lo cerró ni por qué.
      if (forzado && !dto.motivoCierreForzado?.trim()) {
        throw new BadRequestException({
          code: 'MOTIVO_CIERRE_FORZADO_REQUERIDO',
          message: 'Explicá por qué cerrás el turno de otro operador.',
        });
      }
      if (turno.estado === 'CERRADO') throw new BadRequestException('Este turno ya está cerrado.');
      if (turno.cashSessionId) {
        const count = await repo.count({ where: { cashSessionId: turno.cashSessionId, estado: 'ABIERTO' } });
        if (count > 1) {
          if (dto.cerrarCaja || dto.efectivoContado !== undefined || dto.efectivoParaSiguiente !== undefined) throw new ConflictException('Hay otros operadores en esta caja. Cerrá sólo tu turno; el último realiza el arqueo.');
          Object.assign(turno, { usuarioCierre: { id: usuarioId }, fechaCierre: new Date(), estado: 'CERRADO', cierreCaja: false,
            cierreForzado: forzado, motivoCierreForzado: forzado ? dto.motivoCierreForzado.trim() : null, observaciones: dto.observaciones ?? null });
          return repo.save(turno);
        }
      }
      if (dto.efectivoContado === undefined || dto.cerrarCaja === false) throw new ConflictException('Sos el último operador. Contá el efectivo para cerrar la caja.');
      const paraSiguiente = dto.efectivoParaSiguiente ?? 0;
      if (paraSiguiente > dto.efectivoContado) throw new BadRequestException('No podés entregar más efectivo del que contaste.');
      const teorico = await this.cashTotal(turno, manager);
      if (turno.cashVersion === 2 && dto.efectivoEsperado !== teorico) throw new ConflictException('El efectivo esperado cambió. Actualizá el arqueo antes de confirmar.');
      if (teorico !== dto.efectivoContado && !dto.observaciones?.trim()) throw new BadRequestException('Explicá la diferencia entre el efectivo esperado y el contado.');
      Object.assign(turno, { usuarioCierre: { id: usuarioId }, fechaCierre: new Date(), efectivoContado: dto.efectivoContado,
        efectivoTeorico: teorico, diferencia: teorico - dto.efectivoContado, efectivoParaSiguiente: paraSiguiente,
        efectivoRetirado: dto.efectivoContado - paraSiguiente, observaciones: dto.observaciones ?? null, estado: 'CERRADO',
        cierreForzado: forzado, motivoCierreForzado: forzado ? dto.motivoCierreForzado.trim() : null });
      if (turno.cashSessionId) {
        turno.cierreCaja = true;
        await manager.getRepository(CashSession).update(turno.cashSessionId, { estado: 'CERRADO', fechaCierre: turno.fechaCierre, usuarioCierreId: usuarioId,
          efectivoTeorico: teorico, efectivoContado: dto.efectivoContado, diferencia: teorico - dto.efectivoContado,
          efectivoParaSiguiente: paraSiguiente, efectivoRetirado: dto.efectivoContado - paraSiguiente, observaciones: dto.observaciones ?? null });
      }
      return repo.save(turno);
    });
  }

  // El historial permite buscar por cierre; apertura sigue siendo el valor predeterminado.
  async findAll(filtros: { estado?: 'ABIERTO' | 'CERRADO'; desde?: string; hasta?: string; usuarioId?: string; fechaPor?: 'APERTURA' | 'CIERRE'; soloDiferencias?: boolean } = {}, pagination = { page: 1, limit: 25 }) {
    const campoFecha = filtros.fechaPor === 'CIERRE' ? 't.fechaCierre' : 't.fechaApertura';
    const query = this.turnoRepository.createQueryBuilder('t')
      .leftJoinAndSelect('t.usuarioApertura', 'usuarioApertura')
      .leftJoinAndSelect('t.usuarioCierre', 'usuarioCierre')
      .leftJoinAndSelect('t.caja', 'caja')
      .leftJoinAndSelect('t.cashSession', 'cashSession')
      .orderBy(campoFecha, 'DESC');

    if (filtros.estado) query.andWhere('t.estado = :estado', { estado: filtros.estado });
    if (filtros.usuarioId) query.andWhere('usuarioApertura.id = :usuarioId', { usuarioId: filtros.usuarioId });

    // Las fechas llegan como YYYY-MM-DD y se interpretan en hora de Argentina, no en UTC, o el
    // filtro «hoy» dejaría afuera los turnos abiertos después de las 21.
    if (filtros.desde) {
      query.andWhere(`${campoFecha} >= :desde`, {
        desde: dayjs.tz(`${filtros.desde} 00:00:00`, 'America/Argentina/Buenos_Aires').toDate(),
      });
    }
    if (filtros.hasta) {
      query.andWhere(`${campoFecha} < :hasta`, {
        hasta: dayjs.tz(`${filtros.hasta} 00:00:00`, 'America/Argentina/Buenos_Aires').add(1, 'day').toDate(),
      });
    }

    const stats = await query.clone().select('COUNT(*)', 'total').addSelect('COUNT(*) FILTER (WHERE t.efectivoContado IS NOT NULL AND t.diferencia <> 0)', 'diferencias').addSelect('COUNT(*) FILTER (WHERE t.efectivoContado IS NULL AND t.cashSessionId IS NULL)', 'sinConteo').orderBy().getRawOne();
    if (filtros.soloDiferencias) query.andWhere('t.efectivoContado IS NOT NULL AND t.diferencia <> 0');
    const [data, total] = await query.addOrderBy('t.id', 'DESC').skip((pagination.page - 1) * pagination.limit).take(pagination.limit).getManyAndCount();
    return { data, meta: { totalItems: total, currentPage: pagination.page, itemsPerPage: pagination.limit, totalPages: Math.ceil(total / pagination.limit) }, summary: { total: Number(stats.total), diferencias: Number(stats.diferencias), sinConteo: Number(stats.sinConteo) } };
  }

  // Quiénes abrieron turno alguna vez, para poblar el filtro sin traer todo el historial.
  async findOperadores(): Promise<{ id: string; firstName: string; lastName: string }[]> {
    return this.turnoRepository.createQueryBuilder('t').innerJoin('t.usuarioApertura', 'u')
      .select('u.id', 'id').addSelect('u.firstName', 'firstName').addSelect('u.lastName', 'lastName')
      .distinct(true).orderBy('u.firstName', 'ASC').addOrderBy('u.id', 'ASC').getRawMany();
  }
}
