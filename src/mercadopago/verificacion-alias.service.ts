import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, MoreThanOrEqual, Repository } from 'typeorm';
import { CuentaMercadoPago } from './entities/cuenta-mercadopago.entity';
import {
  CobroTransferencia,
  ModoAsociacion,
} from './entities/cobro-transferencia.entity';
import { TransferenciaRecibida } from './entities/transferencia-recibida.entity';
import { EmpresaAdicional } from 'src/saas/entities/empresa-adicional.entity';
import { TicketRegistration } from 'src/tickets/entities/ticket-registration.entity';
import { TicketRegistrationForDay } from 'src/tickets/entities/ticket-registration-for-day.entity';
import { MercadoPagoService } from './mercadopago.service';
import { TicketsService } from 'src/tickets/tickets.service';
import { CONDICIONES_VIGENTES } from './condiciones';
import {
  GRACIA_PAGO_TARDIO_MS,
  compite,
  decidir,
  datosDelPagador,
  esTransferenciaRecibida,
} from './coincidencias';
import { tenantContext } from 'src/tenancy/tenant-context';

const API = 'https://api.mercadopago.com';
const TIEMPO_LIMITE_MS = 12_000;
// Cuánto se espera la transferencia antes de dar el intento por vencido.
const ESPERA_MS = 15 * 60 * 1000;
// Margen hacia atrás al abrir el intento (el cliente pudo transferir antes de que se eligiera el
// medio) y el máximo al que el operador lo puede ampliar.
const VENTANA_INICIAL_MIN = 1;
const VENTANA_AMPLIADA_MIN = 5;
// Las pantallas preguntan cada pocos segundos; a MercadoPago se le pregunta como mucho una vez en
// este rato por cuenta, aunque haya muchas cajas esperando a la vez.
const REUSO_MS = 4_000;
// La búsqueda trae de a 100; más de esto en el período es una consulta que no se puede completar.
const MAXIMO_PAGOS = 500;
const ABIERTOS = ['ESPERANDO', 'REVISION'] as const;

type Lectura =
  | { ok: true; pagos: any[]; consultadoEl: Date }
  | { ok: false; error: string; consultadoEl: Date };

// Una consulta a MercadoPago por cuenta, compartida entre todas las pantallas que esperan una
// transferencia de esa cuenta. Vive en memoria del proceso: con más de una instancia cada una
// consultaría por su lado (mismo criterio que los limitadores del login y del asistente).
const lecturas = new Map<
  string,
  { desde: number; hasta: number; promesa: Promise<Lectura> }
>();

// Nombre y banco de quien pagó, por operación, pedidos al detalle del pago (en memoria, un rato).
const pagadores = new Map<
  string,
  {
    datos: {
      nombre: string | null;
      entidad: string | null;
      documento: string | null;
    };
    hasta: number;
  }
>();

/** Para las pruebas: descarta las consultas compartidas guardadas. */
export const olvidarLecturas = () => {
  lecturas.clear();
  pagadores.clear();
};

/**
 * La verificación de transferencias al alias: el operador elige «Transferencia al alias», el
 * sistema espera el ingreso en la cuenta de MercadoPago de la empresa y, si la coincidencia es
 * única, registra el cobro y la salida. Ver docs/verificacion-transferencias.md.
 *
 * Todo corre en el alcance del pedido (playa del operador). Los intentos y las transferencias se
 * LEEN a nivel empresa para decidir si una coincidencia es única entre todas las playas que
 * cobran con la cuenta, pero cada intento solo lo consulta, confirma o cancela su propia playa.
 */
@Injectable()
export class VerificacionAliasService {
  private readonly logger = new Logger(VerificacionAliasService.name);

  constructor(
    @InjectRepository(CuentaMercadoPago)
    private readonly cuentas: Repository<CuentaMercadoPago>,
    @InjectRepository(CobroTransferencia)
    private readonly intentos: Repository<CobroTransferencia>,
    @InjectRepository(TransferenciaRecibida)
    private readonly transferencias: Repository<TransferenciaRecibida>,
    @InjectRepository(EmpresaAdicional)
    private readonly adicionales: Repository<EmpresaAdicional>,
    private readonly mercadoPago: MercadoPagoService,
    private readonly tickets: TicketsService,
    private readonly dataSource: DataSource,
  ) {}

  private scope() {
    const scope = tenantContext.getStore();
    if (!scope?.empresaId || !scope.playaId || !scope.userId)
      throw new BadRequestException('Elegí una playa para continuar.');
    return scope;
  }

  /**
   * Las tres llaves, en cada consulta y en cada confirmación: la plataforma habilitó el adicional,
   * la cuenta está conectada con las condiciones vigentes aceptadas, y la empresa activó la
   * verificación con su alias.
   */
  private async habilitacion(
    empresaId: string,
  ): Promise<
    | { ok: true; cuenta: CuentaMercadoPago }
    | { ok: false; code: string; message: string }
  > {
    const adicional = await this.adicionales.findOneBy({
      empresaId,
      codigo: 'VERIFICACION_ALIAS',
    });
    if (!adicional?.habilitado)
      return {
        ok: false,
        code: 'ADICIONAL_NO_HABILITADO',
        message:
          'La verificación de transferencias al alias no está habilitada para esta empresa.',
      };
    const cuenta = await this.cuentas.findOneBy({ empresaId });
    if (!cuenta || cuenta.estado !== 'ACTIVA' || !cuenta.accessToken)
      return {
        ok: false,
        code: 'MERCADOPAGO_DESCONECTADO',
        message:
          'La cuenta de MercadoPago no está conectada o dejó de funcionar. Avisale al administrador.',
      };
    if (cuenta.condicionesVersion !== CONDICIONES_VIGENTES.version)
      return {
        ok: false,
        code: 'CONDICIONES_SIN_ACEPTAR',
        message:
          'Falta que un administrador acepte las condiciones de uso de MercadoPago.',
      };
    if (!cuenta.verificacionAlias || !cuenta.alias)
      return {
        ok: false,
        code: 'VERIFICACION_ALIAS_INACTIVA',
        message:
          'El administrador no activó la verificación de transferencias al alias.',
      };
    return { ok: true, cuenta };
  }

  private async exigirHabilitacion(empresaId: string) {
    const h = await this.habilitacion(empresaId);
    if (h.ok === false)
      throw new ForbiddenException({ code: h.code, message: h.message });
    return h.cuenta;
  }

  private empresaActual() {
    const empresaId = tenantContext.getStore()?.empresaId;
    if (!empresaId)
      throw new BadRequestException(
        'Esta acción es de una empresa: entrá como administrador de la empresa.',
      );
    return empresaId;
  }

  /** Lo que ve Configuración → MercadoPago sobre la verificación por alias. */
  async configuracion() {
    const empresaId = this.empresaActual();
    const [adicional, cuenta] = await Promise.all([
      this.adicionales.findOneBy({ empresaId, codigo: 'VERIFICACION_ALIAS' }),
      this.cuentas.findOneBy({ empresaId }),
    ]);
    return {
      // La plataforma la habilitó para esta empresa (sin esto, el interruptor no aparece).
      adicionalHabilitado: !!adicional?.habilitado,
      activa: !!cuenta?.verificacionAlias,
      alias: cuenta?.alias ?? null,
      cambiadaEl: cuenta?.verificacionAliasEl ?? null,
    };
  }

  /**
   * El administrador activa o pausa la verificación y carga el alias. Activarla exige el
   * adicional habilitado, la cuenta conectada y las condiciones vigentes aceptadas; pausarla se
   * puede siempre. Queda quién y cuándo.
   */
  async configurar(
    usuarioId: string,
    dto: { activa: boolean; alias?: string },
  ) {
    const empresaId = this.empresaActual();
    const cuenta = await this.cuentas.findOneBy({ empresaId });
    if (!cuenta || cuenta.estado === 'DESCONECTADA')
      throw new BadRequestException(
        'Primero conectá la cuenta de MercadoPago.',
      );
    const alias = dto.alias?.trim() || cuenta.alias;
    if (dto.activa) {
      const adicional = await this.adicionales.findOneBy({
        empresaId,
        codigo: 'VERIFICACION_ALIAS',
      });
      if (!adicional?.habilitado)
        throw new ForbiddenException({
          code: 'ADICIONAL_NO_HABILITADO',
          message:
            'La verificación de transferencias al alias no está habilitada para esta empresa. Pedísela a la plataforma.',
        });
      if (cuenta.condicionesVersion !== CONDICIONES_VIGENTES.version)
        throw new ForbiddenException({
          code: 'CONDICIONES_SIN_ACEPTAR',
          message: 'Primero aceptá las condiciones de uso de la cuenta.',
        });
      if (!alias)
        throw new BadRequestException(
          'Cargá el alias de la cuenta: es el que ven tus clientes para transferir.',
        );
    }
    cuenta.alias = alias ?? null;
    cuenta.verificacionAlias = dto.activa;
    cuenta.verificacionAliasPor = usuarioId;
    cuenta.verificacionAliasEl = new Date();
    await this.cuentas.save(cuenta);
    return this.configuracion();
  }

  /** Para la pantalla de cobro: si se ofrece «Transferencia al alias» y con qué alias. */
  async disponibilidad() {
    const { empresaId } = this.scope();
    const h = await this.habilitacion(empresaId);
    return h.ok === true
      ? { disponible: true as const, alias: h.cuenta.alias }
      : { disponible: false as const, code: h.code, motivo: h.message };
  }

  /** El intento de esta playa, o 404: los de otras playas se leen, pero no se tocan. */
  private async intentoPropio(id: string, playaId: string) {
    const intento = await this.intentos.findOneBy({ id });
    if (!intento || intento.playaId !== playaId)
      throw new NotFoundException('Cobro no encontrado.');
    return intento;
  }

  /**
   * Abre la espera de una transferencia para una estadía. No registra cobro ni salida. Si la
   * estadía ya tenía un intento abierto, devuelve ese (reabrir la pantalla no duplica nada).
   */
  async iniciar(registrationId: string, tipo: 'HORA' | 'ABONO' = 'HORA') {
    const { empresaId, playaId, userId } = this.scope();
    const cuenta = await this.exigirHabilitacion(empresaId);
    const abierto = await this.intentos.findOneBy({
      registrationId,
      tipo,
      estado: In([...ABIERTOS]),
    });
    if (abierto) {
      if (abierto.playaId !== playaId)
        throw new NotFoundException('Registro no encontrado.');
      return this.consultar(abierto.id);
    }
    // El resumen de cierre lee la estadía con el alcance de la playa: la de otra playa no existe.
    const resumen = tipo === 'ABONO'
      ? await this.resumenAbono(registrationId)
      : await this.tickets.getCloseSummary(registrationId);
    if (resumen.saldoACobrar <= 0)
      throw new BadRequestException('No queda saldo por cobrar.');
    const ahora = Date.now();
    try {
      const nuevo = await this.intentos.save(
        this.intentos.create({
          empresaId,
          playaId,
          registrationId,
          tipo,
          mpUserId: cuenta.mpUserId,
          importe: resumen.saldoACobrar,
          moneda: 'ARS',
          estado: 'ESPERANDO',
          buscarDesde: new Date(ahora - VENTANA_INICIAL_MIN * 60_000),
          ventanaMinutos: VENTANA_INICIAL_MIN,
          venceEl: new Date(ahora + ESPERA_MS),
          creadoPor: userId,
        }),
      );
      return this.consultar(nuevo.id);
    } catch (error: any) {
      // Dos toques seguidos: el índice único deja uno solo abierto por estadía.
      if (error?.code !== '23505') throw error;
      const otro = await this.intentos.findOneBy({
        registrationId,
        tipo,
        estado: In([...ABIERTOS]),
      });
      if (!otro || otro.playaId !== playaId) throw error;
      return this.consultar(otro.id);
    }
  }

  /** El último intento de una estadía de esta playa, para recuperar la pantalla al volver. */
  async deEstadia(registrationId: string, tipo: string = 'HORA') {
    if (tipo !== 'HORA' && tipo !== 'ABONO') throw new BadRequestException('Tipo de estadía inválido.');
    const { playaId } = this.scope();
    const ultimo = await this.intentos.findOne({
      where: { registrationId, playaId, tipo },
      order: { createdAt: 'DESC' },
    });
    if (!ultimo) return null;
    return (ABIERTOS as readonly string[]).includes(ultimo.estado)
      ? this.consultar(ultimo.id)
      : this.vista(ultimo);
  }

  /**
   * Lo que pregunta la pantalla cada pocos segundos: busca ingresos y decide. Un error de
   * MercadoPago se devuelve como error de consulta, nunca como «no pagó».
   */
  async consultar(id: string) {
    const { empresaId, playaId, userId } = this.scope();
    const intento = await this.intentoPropio(id, playaId);
    if (!(ABIERTOS as readonly string[]).includes(intento.estado))
      return this.vista(intento);

    if (await this.cobradaPorOtroMedio(intento.registrationId, intento.tipo)) {
      await this.cerrar(intento.id, 'PAGADO_OTRO_MEDIO');
      return this.vista(await this.intentoPropio(id, playaId));
    }

    const h = await this.habilitacion(empresaId);
    if (h.ok === false)
      return this.vista(intento, {
        consulta: { ok: false, code: h.code, error: h.message },
      });
    const cuenta = h.cuenta;
    if (cuenta.mpUserId !== intento.mpUserId)
      return this.vista(intento, {
        consulta: {
          ok: false,
          code: 'CUENTA_CAMBIADA',
          error:
            'La cuenta de MercadoPago cambió desde que empezó este cobro. Cancelalo y empezá de nuevo.',
        },
      });

    const intentosCuenta = await this.intentosDeCuenta(intento.mpUserId);
    const abiertos = intentosCuenta.filter((i) =>
      (ABIERTOS as readonly string[]).includes(i.estado),
    );
    const desde = new Date(
      Math.min(...abiertos.map((i) => i.buscarDesde.getTime())),
    );
    const lectura = await this.leer(cuenta, desde);
    if (lectura.ok === false)
      return this.vista(intento, {
        consulta: { ok: false, code: 'CONSULTA_FALLIDA', error: lectura.error },
      });

    await this.guardarCandidatas(cuenta, lectura.pagos, intentosCuenta);
    const minimoDesde = new Date(
      Math.min(...intentosCuenta.map((i) => i.buscarDesde.getTime())),
    );
    const transferencias = await this.transferencias.find({
      where: {
        mpUserId: intento.mpUserId,
        fechaOperacion: MoreThanOrEqual(minimoDesde),
      },
    });
    const decision = decidir(intento, transferencias, intentosCuenta);
    const consulta = {
      ok: true as const,
      consultadoEl: lectura.consultadoEl,
    };

    if (decision.tipo === 'CONFIRMAR') {
      try {
        await this.confirmar(
          intento.id,
          decision.operacionId,
          userId,
          'AUTOMATICO_COINCIDENCIA_UNICA',
        );
      } catch (error) {
        // Otra caja la tomó un instante antes o la estadía se cerró por otro lado: la próxima
        // consulta ve el estado nuevo. Nada quedó a medias (fue una sola transacción).
        if (!(error instanceof ConflictException)) throw error;
        await this.siYaCobrada(intento, error);
      }
      // Quién transfirió, para la confirmación en pantalla: en el momento, sin guardarlo.
      const pago = lectura.pagos.find(
        (p) => String(p.id) === decision.operacionId,
      );
      let { nombre } = datosDelPagador(pago);
      if (!nombre)
        ({ nombre } = await this.pagador(cuenta, decision.operacionId, null));
      return this.vista(await this.intentoPropio(id, playaId), {
        consulta,
        pagador: { nombre },
      });
    }

    if (decision.tipo === 'REVISION') {
      // Desde acá ni el intento ni esas transferencias se asocian solos: los elige el operador.
      if (intento.estado === 'ESPERANDO')
        await this.intentos.update(
          { id: intento.id, estado: 'ESPERANDO' },
          { estado: 'REVISION' },
        );
      await this.transferencias.update(
        {
          mpUserId: intento.mpUserId,
          operacionId: In(decision.operaciones),
          estado: 'DISPONIBLE',
        },
        { estado: 'REVISION' },
      );
      const opciones = await Promise.all(
        transferencias
          .filter((t) => decision.operaciones.includes(t.operacionId))
          .map(async (t) => {
            const pago = lectura.pagos.find(
              (p) => String(p.id) === t.operacionId,
            );
            // Lo que haya de quien pagó, en el momento y sin guardarlo. Si la búsqueda no lo trae,
            // se pide el detalle de ese pago, que puede traer más.
            let { nombre, entidad, documento } = datosDelPagador(pago);
            if (!nombre || !documento) {
              const detalle = await this.pagador(
                cuenta,
                t.operacionId,
                entidad,
              );
              nombre = detalle.nombre ?? nombre;
              entidad = detalle.entidad ?? entidad;
              documento = detalle.documento ?? documento;
            }
            return {
              operacionId: t.operacionId,
              importe: t.importe,
              moneda: t.moneda,
              fechaOperacion: t.fechaOperacion,
              detectadaEl: t.detectadaEl,
              nombre,
              entidad,
              documento,
            };
          }),
      );
      return this.vista(await this.intentoPropio(id, playaId), {
        consulta,
        motivoRevision: decision.motivo,
        opciones,
      });
    }

    if (
      intento.estado === 'ESPERANDO' &&
      Date.now() >= intento.venceEl.getTime()
    )
      await this.cerrar(intento.id, 'VENCIDO');
    return this.vista(await this.intentoPropio(id, playaId), { consulta });
  }

  /** El operador eligió cuál de las transferencias es la de este cliente. */
  async asignar(id: string, operacionId: string) {
    const { empresaId, playaId, userId } = this.scope();
    const intento = await this.intentoPropio(id, playaId);
    if (!(ABIERTOS as readonly string[]).includes(intento.estado))
      throw new ConflictException({
        code: 'COBRO_CERRADO',
        message: 'Este cobro ya no está esperando una transferencia.',
      });
    const cuenta = await this.exigirHabilitacion(empresaId);
    try {
      await this.confirmar(intento.id, operacionId, userId, 'MANUAL');
    } catch (error) {
      if (error instanceof ConflictException)
        await this.siYaCobrada(intento, error);
      throw error;
    }
    const { nombre } = await this.pagador(cuenta, operacionId, null);
    return this.vista(await this.intentoPropio(id, playaId), {
      pagador: { nombre },
    });
  }

  /** Busca desde cinco minutos antes de abrir el cobro, una sola vez. */
  async ampliar(id: string) {
    const { playaId } = this.scope();
    const intento = await this.intentoPropio(id, playaId);
    if (
      (ABIERTOS as readonly string[]).includes(intento.estado) &&
      intento.ventanaMinutos < VENTANA_AMPLIADA_MIN
    )
      await this.intentos.update(
        { id: intento.id, estado: In([...ABIERTOS]) },
        {
          ventanaMinutos: VENTANA_AMPLIADA_MIN,
          buscarDesde: new Date(
            intento.createdAt.getTime() - VENTANA_AMPLIADA_MIN * 60_000,
          ),
        },
      );
    return this.consultar(id);
  }

  /** La estadía sigue pendiente de cobro. Si después llega la plata, queda sin asociar. */
  async cancelar(id: string) {
    const { playaId } = this.scope();
    const intento = await this.intentoPropio(id, playaId);
    if ((ABIERTOS as readonly string[]).includes(intento.estado))
      await this.cerrar(intento.id, 'CANCELADO');
    return this.vista(await this.intentoPropio(id, playaId));
  }

  /**
   * Asocia la transferencia y registra el cobro (y la salida si no queda saldo) en UNA
   * transacción. Los bloqueos de fila sobre el intento y la transferencia hacen que dos cajas que
   * intentan usar la misma operación a la vez se ordenen: la segunda la encuentra USADA. Los
   * índices únicos (cuenta + operación, en las dos tablas) son la red de la base.
   */
  private async confirmar(
    intentoId: string,
    operacionId: string,
    usuarioId: string,
    modo: ModoAsociacion,
  ) {
    const registro = await this.dataSource.transaction(async (m) => {
      const repoI = m.getRepository(CobroTransferencia);
      const repoT = m.getRepository(TransferenciaRecibida);
      const intento = await repoI.findOne({
        where: { id: intentoId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !intento ||
        !(ABIERTOS as readonly string[]).includes(intento.estado) ||
        (modo === 'AUTOMATICO_COINCIDENCIA_UNICA' &&
          intento.estado !== 'ESPERANDO')
      )
        throw new ConflictException({
          code: 'COBRO_CERRADO',
          message: 'Este cobro ya no está esperando una transferencia.',
        });
      const t = await repoT.findOne({
        where: { mpUserId: intento.mpUserId, operacionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!t)
        throw new NotFoundException(
          'Esa transferencia no está entre las opciones de este cobro.',
        );
      if (t.estado === 'USADA')
        throw new ConflictException({
          code: 'TRANSFERENCIA_USADA',
          message: 'Esta transferencia ya fue utilizada.',
        });
      if (modo === 'AUTOMATICO_COINCIDENCIA_UNICA' && t.estado !== 'DISPONIBLE')
        throw new ConflictException({
          code: 'TRANSFERENCIA_EN_REVISION',
          message: 'Esta transferencia quedó en revisión.',
        });
      if (!compite({ ...intento, cerradoEl: null }, t))
        throw new BadRequestException(
          'Esa transferencia no corresponde a este cobro: el importe o la hora no coinciden.',
        );

      const acreditar = intento.tipo === 'ABONO'
        ? this.tickets.acreditarTransferenciaAbonoEn.bind(this.tickets)
        : this.tickets.acreditarTransferenciaEn.bind(this.tickets);
      const r = await acreditar(
        m,
        intento.registrationId,
        intento.importe,
        `Transferencia MercadoPago ${operacionId}`,
        usuarioId,
      );
      if (r.yaCerrada)
        throw new ConflictException({
          code: 'ESTADIA_YA_COBRADA',
          message: 'La estadía ya se cobró por otro medio.',
        });

      const ahora = new Date();
      await repoT.update(
        { id: t.id },
        {
          estado: 'USADA',
          cobroId: intento.id,
          registrationId: intento.registrationId,
          usadaEnPlayaId: intento.playaId,
          modo,
          usadaEl: ahora,
          usadaPor: usuarioId,
        },
      );
      await repoI.update(
        { id: intento.id },
        {
          estado: 'CONFIRMADO',
          operacionId,
          modo,
          confirmadoPor: usuarioId,
          cerradoEl: ahora,
          salidaRegistrada: r.cerrada,
          saldoPendiente: r.saldoPendiente || null,
        },
      );
      return intento.tipo === 'ABONO' ? null : r.registration as TicketRegistration;
    });
    if (registro) this.tickets.emitirRegistro(registro);
    this.logger.log(
      `Cobro por transferencia ${intentoId} confirmado con la operación ${operacionId} (${modo}).`,
    );
  }

  // Si la confirmación falló porque la estadía ya estaba cobrada, el intento termina ahí.
  private async siYaCobrada(intento: CobroTransferencia, error: unknown) {
    const code = (error as any)?.getResponse?.()?.code;
    if (code === 'ESTADIA_YA_COBRADA')
      await this.cerrar(intento.id, 'PAGADO_OTRO_MEDIO');
  }

  private async cerrar(
    id: string,
    estado: 'CANCELADO' | 'VENCIDO' | 'PAGADO_OTRO_MEDIO',
  ) {
    await this.intentos.update(
      { id, estado: In([...ABIERTOS]) },
      { estado, cerradoEl: new Date() },
    );
  }

  private async resumenAbono(id: string) {
    const registro = await this.tickets.getRegistrationForDay(id);
    if (!registro || registro.playaId !== this.scope().playaId) throw new NotFoundException('Abono no encontrado.');
    if (registro.retired) throw new BadRequestException('Este abono ya está cerrado.');
    return { saldoACobrar: registro.paid ? 0 : registro.price };
  }

  private async cobradaPorOtroMedio(registrationId: string, tipo: 'HORA' | 'ABONO' = 'HORA') {
    if (tipo === 'ABONO') {
      const registro = await this.dataSource.getRepository(TicketRegistrationForDay).findOneBy({ id: registrationId });
      return !registro || !!registro.retired || !!registro.paid;
    }
    const registro = await this.dataSource
      .getRepository(TicketRegistration)
      .findOneBy({ id: registrationId });
    if (!registro || registro.departureTime) return true;
    const resumen = await this.tickets.getCloseSummary(registrationId);
    return resumen.saldoACobrar <= 0;
  }

  /**
   * Los intentos de TODAS las playas que cobran con esta cuenta y que importan para decidir: los
   * abiertos, y los cerrados hace poco (un pago tardío puede ser de ellos).
   */
  private async intentosDeCuenta(mpUserId: string) {
    const limite = new Date(Date.now() - GRACIA_PAGO_TARDIO_MS - ESPERA_MS);
    return this.intentos
      .createQueryBuilder('i')
      .where('i.mpUserId = :mpUserId', { mpUserId })
      .andWhere('(i.estado IN (:...abiertos) OR i.cerradoEl >= :limite)', {
        abiertos: [...ABIERTOS],
        limite,
      })
      .getMany();
  }

  /**
   * Guarda las transferencias recibidas que coinciden en importe con algún intento que importa. Las
   * demás (otros importes, pagos que no son transferencias) no se guardan. Repetir la consulta no
   * duplica nada: la operación es única por cuenta.
   */
  private async guardarCandidatas(
    cuenta: CuentaMercadoPago,
    pagos: any[],
    intentosCuenta: CobroTransferencia[],
  ) {
    const importes = intentosCuenta
      .filter((i) => i.estado !== 'CONFIRMADO')
      .map((i) => i.importe);
    const filas = pagos
      .filter((p) => esTransferenciaRecibida(p, cuenta.mpUserId))
      .filter((p) =>
        importes.some(
          (importe) => Math.abs(Number(p.transaction_amount) - importe) < 0.005,
        ),
      )
      .map((p) => ({
        empresaId: cuenta.empresaId,
        mpUserId: cuenta.mpUserId,
        operacionId: String(p.id),
        importe: Number(p.transaction_amount),
        moneda: String(p.currency_id),
        estadoMp: String(p.status),
        paymentTypeId: p.payment_type_id ?? p.payment_method?.type ?? null,
        fechaOperacion: new Date(p.date_created),
        fechaAcreditacion: p.date_approved ? new Date(p.date_approved) : null,
      }));
    if (!filas.length) return;
    await this.transferencias
      .createQueryBuilder()
      .insert()
      .into(TransferenciaRecibida)
      .values(filas)
      .orIgnore()
      .execute();
  }

  /**
   * Nombre y banco de quien pagó una operación, desde el detalle del pago (`GET /v1/payments/:id`).
   * Solo para las opciones en revisión que la búsqueda trajo sin nombre; queda unos minutos en
   * memoria para no pedirlo en cada consulta de la pantalla. Si falla, no hay nombre: no es error.
   */
  private async pagador(
    cuenta: CuentaMercadoPago,
    operacionId: string,
    entidad: string | null,
  ): Promise<{
    nombre: string | null;
    entidad: string | null;
    documento: string | null;
  }> {
    const clave = `${cuenta.mpUserId}:${operacionId}`;
    const guardado = pagadores.get(clave);
    if (guardado && guardado.hasta > Date.now()) return guardado.datos;
    let datos = {
      nombre: null as string | null,
      entidad,
      documento: null as string | null,
    };
    try {
      const token = await this.mercadoPago.tokenDeEmpresa(cuenta.empresaId);
      const respuesta = await fetch(`${API}/v1/payments/${operacionId}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
      });
      if (respuesta.ok) {
        const pago = await respuesta.json();
        if (String(pago?.collector_id) === String(cuenta.mpUserId)) {
          const d = datosDelPagador(pago);
          datos = {
            nombre: d.nombre,
            entidad: d.entidad ?? entidad,
            documento: d.documento,
          };
        }
      } else await respuesta.body?.cancel();
    } catch {
      // Sin detalle se muestra sin nombre; la elección sigue siendo del operador.
    }
    pagadores.set(clave, { datos, hasta: Date.now() + 5 * 60_000 });
    return datos;
  }

  /**
   * Los pagos de la cuenta desde `desde`, de a 100 y hasta MAXIMO_PAGOS. Si la búsqueda no se
   * puede completar, es un error: no se decide con una lista parcial.
   */
  private leer(cuenta: CuentaMercadoPago, desde: Date): Promise<Lectura> {
    const ahora = Date.now();
    const previa = lecturas.get(cuenta.mpUserId);
    if (previa && previa.hasta > ahora && previa.desde <= desde.getTime())
      return previa.promesa;
    const promesa = this.buscar(cuenta, desde);
    lecturas.set(cuenta.mpUserId, {
      desde: desde.getTime(),
      hasta: ahora + REUSO_MS,
      promesa,
    });
    return promesa;
  }

  private async buscar(
    cuenta: CuentaMercadoPago,
    desde: Date,
  ): Promise<Lectura> {
    const consultadoEl = new Date();
    let token: string;
    try {
      token = await this.mercadoPago.tokenDeEmpresa(cuenta.empresaId);
    } catch (error) {
      return {
        ok: false,
        consultadoEl,
        error:
          error instanceof Error
            ? error.message
            : 'No se pudo usar la cuenta de MercadoPago.',
      };
    }
    const pagos: any[] = [];
    for (let offset = 0; offset < MAXIMO_PAGOS; offset += 100) {
      const busqueda = new URLSearchParams({
        sort: 'date_created',
        criteria: 'desc',
        range: 'date_created',
        // Un minuto de margen para los relojes de MercadoPago y del servidor.
        begin_date: new Date(desde.getTime() - 60_000).toISOString(),
        end_date: new Date(Date.now() + 60_000).toISOString(),
        limit: '100',
        offset: String(offset),
      });
      let respuesta: Response;
      try {
        respuesta = await fetch(`${API}/v1/payments/search?${busqueda}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
        });
      } catch {
        return {
          ok: false,
          consultadoEl,
          error: 'No se pudo consultar MercadoPago. Reintentá en un momento.',
        };
      }
      if (!respuesta.ok) {
        // El cuerpo no se loguea: puede traer datos de pagos.
        await respuesta.body?.cancel();
        this.logger.warn(
          `MercadoPago respondió ${respuesta.status} a la búsqueda de pagos de la cuenta ${cuenta.mpUserId}.`,
        );
        return {
          ok: false,
          consultadoEl,
          error: `No se pudo consultar MercadoPago (respondió ${respuesta.status}). Reintentá en un momento.`,
        };
      }
      const datos = (await respuesta.json()) as {
        results?: any[];
        paging?: { total?: number };
      };
      const pagina = datos.results ?? [];
      pagos.push(...pagina);
      const total = datos.paging?.total ?? pagos.length;
      if (pagos.length >= total || pagina.length === 0)
        return { ok: true, pagos, consultadoEl };
    }
    return {
      ok: false,
      consultadoEl,
      error:
        'Entraron demasiados pagos en el período para revisarlos todos. Cancelá y cobrá de otra forma.',
    };
  }

  /** Lo que ve la pantalla de cobro. Sin tokens ni respuestas de MercadoPago. */
  private async vista(
    intento: CobroTransferencia,
    extra: {
      consulta?:
        | { ok: true; consultadoEl: Date }
        | { ok: false; code: string; error: string };
      motivoRevision?: string;
      opciones?: unknown[];
      // Quién pagó la transferencia recién asociada; solo en la respuesta que la confirma.
      pagador?: { nombre: string | null };
    } = {},
  ) {
    const cuenta = await this.cuentas.findOneBy({
      empresaId: intento.empresaId,
    });
    const usada =
      intento.estado === 'CONFIRMADO' && intento.operacionId
        ? await this.transferencias.findOneBy({
            mpUserId: intento.mpUserId,
            operacionId: intento.operacionId,
          })
        : null;
    return {
      id: intento.id,
      registrationId: intento.registrationId,
      tipo: intento.tipo,
      estado: intento.estado,
      importe: intento.importe,
      moneda: intento.moneda,
      alias: cuenta?.alias ?? null,
      creadoEl: intento.createdAt,
      buscarDesde: intento.buscarDesde,
      ventanaMinutos: intento.ventanaMinutos,
      puedeAmpliar: intento.ventanaMinutos < VENTANA_AMPLIADA_MIN,
      venceEl: intento.venceEl,
      cerradoEl: intento.cerradoEl,
      modo: intento.modo,
      salidaRegistrada: intento.salidaRegistrada,
      saldoPendiente: intento.saldoPendiente,
      transferencia: usada
        ? {
            operacionId: usada.operacionId,
            importe: usada.importe,
            fechaOperacion: usada.fechaOperacion,
            detectadaEl: usada.detectadaEl,
            nombre: extra.pagador?.nombre ?? null,
          }
        : null,
      consulta: extra.consulta ?? null,
      motivoRevision: extra.motivoRevision ?? null,
      opciones: extra.opciones ?? [],
    };
  }
}
