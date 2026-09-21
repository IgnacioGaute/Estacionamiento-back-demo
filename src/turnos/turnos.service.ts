import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Not, Repository } from 'typeorm';
import { Turno } from './entities/turno.entity';
import { CashEntry } from './entities/cash-entry.entity';
import { Movimiento } from 'src/movimientos/entities/movimiento.entity';
import { OpenTurnoDto } from './dto/open-turno.dto';
import { CloseTurnoDto } from './dto/close-turno.dto';
import { UserRole } from 'src/users/entities/user.entity';
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
    // Mismo orden de locks que cobros y cierre: caja compartida, luego turno.
    if (manager) await manager.query('SELECT pg_advisory_xact_lock(718904)');
    const repository = (manager ?? this.dataSource.manager).getRepository(Turno);
    const shared = await repository.findOne({ where: { estado: 'ABIERTO', cashVersion: 2 }, ...(manager ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    return shared ?? repository.findOne({ where: { usuarioApertura: { id: usuarioId }, estado: 'ABIERTO' }, ...(manager ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
  }

  async getOpenTurno(usuarioId: string) {
    const turno = await this.findOpenTurnoOrNull(usuarioId);
    if (!turno) throw new NotFoundException({ code: 'NO_OPEN_TURNO', message: 'No hay un turno de caja abierto.' });
    return turno;
  }

  private async cashTotal(turno: Turno, manager: EntityManager) {
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

  async getCashContext() {
    return this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const repo = manager.getRepository(Turno);
      const active = await repo.findOne({ where: { estado: 'ABIERTO' }, relations: ['usuarioApertura'], order: { fechaApertura: 'DESC' } });
      const last = await repo.findOne({ where: { estado: 'CERRADO', efectivoParaSiguiente: Not(IsNull()), recibidoPorTurnoId: IsNull() }, relations: ['usuarioCierre'], order: { fechaCierre: 'DESC' } });
      const pending = last && !last.recibidoPorTurnoId ? last : null;
      const publicPending = pending && tenantContext.getStore()?.role === 'USER'
        ? { id: pending.id, nombre: pending.nombre, fechaCierre: pending.fechaCierre, efectivoParaSiguiente: pending.efectivoParaSiguiente }
        : pending;
      return { active, pending: publicPending, efectivoDisponible: active ? await this.cashTotal(active, manager) : pending?.efectivoParaSiguiente ?? 0 };
    });
  }

  async open(usuarioId: string, dto: OpenTurnoDto): Promise<Turno> {
    return this.dataSource.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(718904)');
      const repo = manager.getRepository(Turno);
      if (await repo.exists({ where: { estado: 'ABIERTO' } })) throw new ConflictException('Ya hay un turno abierto en esta caja. Cerralo antes del relevo.');
      const last = await repo.findOne({ where: { estado: 'CERRADO', efectivoParaSiguiente: Not(IsNull()), recibidoPorTurnoId: IsNull() }, order: { fechaCierre: 'DESC' } });
      const pending = last && !last.recibidoPorTurnoId ? last : null;
      if ((pending?.id ?? undefined) !== dto.turnoAnteriorId) throw new ConflictException('El relevo cambió. Actualizá la caja y confirmá el fondo que recibís.');
      const recibido = pending?.efectivoParaSiguiente ?? 0;
      if (dto.fondoInicial < recibido) throw new BadRequestException('El fondo inicial no puede ser menor al efectivo entregado por el turno anterior.');
      const turno = await repo.save(repo.create({ usuarioApertura: { id: usuarioId }, fondoInicial: dto.fondoInicial,
        nombre: dto.nombre?.trim() || 'Turno', duracionPrevistaHoras: dto.duracionPrevistaHoras ?? null,
        cashVersion: 2, estado: 'ABIERTO', fondoRecibido: recibido, turnoAnteriorId: pending?.id ?? null }));
      if (pending) { pending.recibidoPorTurnoId = turno.id; await repo.save(pending); }
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
      const paraSiguiente = dto.efectivoParaSiguiente ?? 0;
      if (paraSiguiente > dto.efectivoContado) throw new BadRequestException('No podés entregar más efectivo del que contaste.');
      const teorico = await this.cashTotal(turno, manager);
      if (turno.cashVersion === 2 && dto.efectivoEsperado !== teorico) throw new ConflictException('El efectivo esperado cambió. Actualizá el arqueo antes de confirmar.');
      if (teorico !== dto.efectivoContado && !dto.observaciones?.trim()) throw new BadRequestException('Explicá la diferencia entre el efectivo esperado y el contado.');
      Object.assign(turno, { usuarioCierre: { id: usuarioId }, fechaCierre: new Date(), efectivoContado: dto.efectivoContado,
        efectivoTeorico: teorico, diferencia: teorico - dto.efectivoContado, efectivoParaSiguiente: paraSiguiente,
        efectivoRetirado: dto.efectivoContado - paraSiguiente, observaciones: dto.observaciones ?? null, estado: 'CERRADO',
        cierreForzado: forzado, motivoCierreForzado: forzado ? dto.motivoCierreForzado.trim() : null });
      return repo.save(turno);
    });
  }

  // El historial permite buscar por cierre; apertura sigue siendo el valor predeterminado.
  async findAll(filtros: { estado?: 'ABIERTO' | 'CERRADO'; desde?: string; hasta?: string; usuarioId?: string; fechaPor?: 'APERTURA' | 'CIERRE' } = {}): Promise<Turno[]> {
    const campoFecha = filtros.fechaPor === 'CIERRE' ? 't.fechaCierre' : 't.fechaApertura';
    const query = this.turnoRepository.createQueryBuilder('t')
      .leftJoinAndSelect('t.usuarioApertura', 'usuarioApertura')
      .leftJoinAndSelect('t.usuarioCierre', 'usuarioCierre')
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

    return query.getMany();
  }

  // Quiénes abrieron turno alguna vez, para poblar el filtro sin traer todo el historial.
  async findOperadores(): Promise<{ id: string; firstName: string; lastName: string }[]> {
    const turnos = await this.turnoRepository.find({ relations: ['usuarioApertura'], select: { id: true } });
    const porId = new Map<string, { id: string; firstName: string; lastName: string }>();
    for (const turno of turnos) {
      if (turno.usuarioApertura) {
        porId.set(turno.usuarioApertura.id, {
          id: turno.usuarioApertura.id,
          firstName: turno.usuarioApertura.firstName,
          lastName: turno.usuarioApertura.lastName,
        });
      }
    }
    return [...porId.values()].sort((a, b) => a.firstName.localeCompare(b.firstName));
  }
}
