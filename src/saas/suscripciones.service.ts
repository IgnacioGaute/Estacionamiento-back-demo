import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditLog } from 'src/tenancy/entities/audit-log.entity';
import type { EmpresaEstado } from 'src/tenancy/entities/empresa.entity';
import { Plan } from './entities/plan.entity';
import { PlanDePlaya } from './entities/plan-de-playa.entity';
import { DebitoEstado, Suscripcion } from './entities/suscripcion.entity';
import { FacturaSaas, LineaFactura } from './entities/factura-saas.entity';
import {
  ActivarCuentaDto,
  AsignarPlanDto,
  EditarPlanDto,
  EditarSuscripcionDto,
  RegistrarPagoSaasDto,
} from './dto/suscripciones.dto';
import {
  DIAS_HASTA_BAJA,
  DatosCuenta,
  SituacionCuenta,
  ZONA,
  correspondeFactura,
  cortadaPorFaltaDePago,
  diasEntre,
  finDePrueba,
  hoyAR,
  periodoDelPago,
  periodoSiguiente,
  situacionDeCuenta,
  sumarDias,
} from './estado-cuenta';

// La landing lo promete: cada playa además de la primera paga 30% menos que su plan.
export const DESCUENTO_PLAYA_ADICIONAL = 0.3;

// El alta de una cuenta que todavía no tiene fila (empresa anterior a los planes): el día en que se
// creó la empresa, en Argentina. `createdAt` se guarda en UTC sin zona.
const ALTA = `COALESCE(s.alta, ((e."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE '${ZONA}')::date)::text AS alta`;
const CAMPOS_CUENTA = `e.estado AS "empresaEstado", ${ALTA},
  s."pruebaHasta"::text AS "pruebaHasta", s."pagadoHasta"::text AS "pagadoHasta",
  s."prorrogaHasta"::text AS "prorrogaHasta", COALESCE(s.bonificada, false) AS bonificada,
  s."motivoSuspension", s."suspendidaEl", s.notas,
  COALESCE(s."debitoEstado" = 'authorized', false) AS "conDebito",
  s."debitoId", s."debitoEstado", s."debitoEmail", s."debitoUrl", s."debitoImporte"`;

type FilaCuenta = DatosCuenta & {
  empresaId: string;
  suspendidaEl: Date | null;
  notas: string | null;
  debitoId: string | null;
  debitoEstado: DebitoEstado | null;
  debitoEmail: string | null;
  debitoUrl: string | null;
  debitoImporte: number | null;
};

type LineaPlan = {
  playaId: string;
  playa: string;
  planId: string;
  plan: string;
  codigo: string;
  maxActivos: number | null;
  incluyeCocheras: boolean;
  precio: number;
  precioLista: number;
  desde: string;
};

export type ResumenCuenta = SituacionCuenta & {
  alta: string;
  pruebaHasta: string | null;
  pagadoHasta: string | null;
  prorrogaHasta: string | null;
  bonificada: boolean;
  motivoSuspension: DatosCuenta['motivoSuspension'];
  suspendidaEl: string | null;
  // Lo que paga por mes: la suma de los planes de sus playas.
  mensual: number;
  planes: LineaPlan[];
  facturaPendiente: {
    id: string;
    importe: number;
    desde: string;
    hasta: string;
  } | null;
  ultimoPago: { fecha: string; importe: number; medio: string | null } | null;
  // Débito automático con MercadoPago. `url` solo mientras falta confirmarlo.
  debito: {
    estado: DebitoEstado;
    email: string | null;
    url: string | null;
  } | null;
};

const ACCIONES_DE_CUENTA = [
  'SUSCRIPCION_%',
  'EMPRESA_SUSPENDIDA',
  'EMPRESA_ACTIVA',
  'EMPRESA_BAJA',
  'EMPRESA_REACTIVADA',
  'EMPRESA_CREADA',
];

// La cuenta de cada empresa con la plataforma: qué plan tiene cada playa, desde cuándo es cliente,
// hasta cuándo pagó y qué pasa cuando vence. El estado se deduce siempre de las fechas
// (estado-cuenta.ts); lo único que se escribe es lo que pasó: el alta, un pago, días extra, un
// cambio de plan, una suspensión.
//
// Las mutaciones son del super admin (TenancyController y SuscripcionesController no pasan por el
// TenantInterceptor, así que corren con el rol dueño) o de la tarea diaria, que tampoco tiene
// scope. La empresa solo lee lo suyo (MiPlanController), con RLS de por medio.
@Injectable()
export class SuscripcionesService {
  private readonly logger = new Logger(SuscripcionesService.name);

  constructor(private readonly dataSource: DataSource) {}

  // ─── Lectura ────────────────────────────────────────────────────────────

  async resumenes(
    empresaIds: string[],
    hoy = hoyAR(),
  ): Promise<Map<string, ResumenCuenta>> {
    const resultado = new Map<string, ResumenCuenta>();
    if (!empresaIds.length) return resultado;
    const q = (sql: string) => this.dataSource.query(sql, [empresaIds]);
    // Una empresa sin fila (creada antes de los planes y todavía sin migrar) se lee SIN_ACTIVAR.
    const [cuentas, lineas, pendientes, ultimos] = await Promise.all([
      q(`SELECT e.id AS "empresaId", ${CAMPOS_CUENTA}
         FROM empresas e LEFT JOIN suscripciones s ON s."empresaId" = e.id
         WHERE e.id = ANY($1)`),
      q(`SELECT sp."empresaId", sp."playaId", pl.nombre AS playa, sp."planId", p.nombre AS plan,
                p.codigo, p."maxActivos", p."incluyeCocheras", sp.precio,
                p."precioMensual" AS "precioLista", sp.desde::text AS desde
         FROM suscripcion_playas sp
         JOIN planes p ON p.id = sp."planId"
         JOIN playas pl ON pl.id = sp."playaId"
         WHERE sp."empresaId" = ANY($1)
         ORDER BY pl.nombre, pl.id`),
      q(`SELECT id, "empresaId", importe, desde::text AS desde, hasta::text AS hasta
         FROM facturas_saas WHERE estado = 'PENDIENTE' AND "empresaId" = ANY($1)`),
      q(`SELECT DISTINCT ON ("empresaId") "empresaId", importe, "pagadaEl"::text AS fecha, medio
         FROM facturas_saas WHERE estado = 'PAGADA' AND "empresaId" = ANY($1)
         ORDER BY "empresaId", "pagadaEl" DESC, "createdAt" DESC`),
    ]);
    for (const fila of cuentas as FilaCuenta[]) {
      const planes: LineaPlan[] = lineas
        .filter((l: any) => l.empresaId === fila.empresaId)
        .map((l: any) => ({
          playaId: l.playaId,
          playa: l.playa,
          planId: l.planId,
          plan: l.plan,
          codigo: l.codigo,
          maxActivos: l.maxActivos === null ? null : Number(l.maxActivos),
          incluyeCocheras: !!l.incluyeCocheras,
          precio: Number(l.precio),
          precioLista: Number(l.precioLista),
          desde: l.desde,
        }));
      const pendiente = pendientes.find(
        (p: any) => p.empresaId === fila.empresaId,
      );
      const ultimo = ultimos.find((p: any) => p.empresaId === fila.empresaId);
      resultado.set(fila.empresaId, {
        ...situacionDeCuenta(fila, hoy),
        alta: fila.alta,
        pruebaHasta: fila.pruebaHasta,
        pagadoHasta: fila.pagadoHasta,
        prorrogaHasta: fila.prorrogaHasta,
        bonificada: !!fila.bonificada,
        motivoSuspension: fila.motivoSuspension,
        suspendidaEl: fila.suspendidaEl
          ? new Date(fila.suspendidaEl).toISOString()
          : null,
        mensual: planes.reduce((n, l) => n + l.precio, 0),
        planes,
        facturaPendiente: pendiente
          ? {
              id: pendiente.id,
              importe: Number(pendiente.importe),
              desde: pendiente.desde,
              hasta: pendiente.hasta,
            }
          : null,
        ultimoPago: ultimo
          ? {
              fecha: ultimo.fecha,
              importe: Number(ultimo.importe),
              medio: ultimo.medio,
            }
          : null,
        debito:
          fila.debitoEstado && fila.debitoEstado !== 'cancelled'
            ? {
                estado: fila.debitoEstado,
                email: fila.debitoEmail,
                url: fila.debitoEstado === 'pending' ? fila.debitoUrl : null,
              }
            : null,
      });
    }
    return resultado;
  }

  async resumen(empresaId: string) {
    const resumen = (await this.resumenes([empresaId])).get(empresaId);
    if (!resumen) throw new NotFoundException('Empresa no encontrada.');
    return resumen;
  }

  /** Lo justo para los avisos del menú: corre en cada carga del contexto. */
  async situacion(empresaId: string) {
    // Lo que debe (la factura pendiente) o, si todavía no se emitió, lo que paga por mes: el aviso
    // del menú dice el importe sin tener que abrir Mi plan.
    const [fila] = await this.dataSource.query(
      `SELECT ${CAMPOS_CUENTA},
              (SELECT f.importe FROM facturas_saas f
               WHERE f."empresaId" = e.id AND f.estado = 'PENDIENTE') AS pendiente,
              (SELECT COALESCE(SUM(sp.precio), 0) FROM suscripcion_playas sp
               WHERE sp."empresaId" = e.id) AS mensual
       FROM empresas e LEFT JOIN suscripciones s ON s."empresaId" = e.id
       WHERE e.id = $1`,
      [empresaId],
    );
    if (!fila) return null;
    return {
      ...situacionDeCuenta(fila),
      motivoSuspension: fila.motivoSuspension ?? null,
      aPagar: Number(fila.pendiente ?? fila.mensual ?? 0),
      // Con débito automático el aviso de «vence en unos días» sobra: se cobra solo.
      conDebito: !!fila.conDebito,
    };
  }

  /** La ficha del super admin: cuenta, plan y uso de cada playa, facturas e historial. */
  async detalle(empresaId: string) {
    const resumen = await this.resumen(empresaId);
    const [playas, facturas, historial, principal] = await Promise.all([
      this.dataSource.query(
        `SELECT id, nombre, modulos FROM playas WHERE "empresaId" = $1 ORDER BY nombre, id`,
        [empresaId],
      ),
      this.facturas(empresaId, 60),
      this.dataSource.query(
        `SELECT a.accion, a.entidad, a.detalle, a.fecha, u."firstName", u."lastName"
         FROM audit_log a LEFT JOIN users u ON u.id = a."usuarioId"
         WHERE a."empresaId" = $1 AND a.accion LIKE ANY($2)
         ORDER BY a.fecha DESC LIMIT 60`,
        [empresaId, ACCIONES_DE_CUENTA],
      ),
      this.playaPrincipal(this.dataSource.manager, empresaId),
    ]);
    const uso = await this.usoDePlayas(playas.map((p: any) => p.id));
    const [fila] = await this.dataSource.query(
      'SELECT notas FROM suscripciones WHERE "empresaId" = $1',
      [empresaId],
    );
    return {
      cuenta: resumen,
      notas: fila?.notas ?? null,
      playas: playas.map((p: any) => {
        const linea = resumen.planes.find((l) => l.playaId === p.id) ?? null;
        const u = uso.get(p.id);
        return {
          playaId: p.id,
          nombre: p.nombre,
          inquilinos: !!p.modulos?.inquilinos,
          plan: linea,
          // Paga con el descuento de playa adicional: hay otra que tuvo plan antes.
          adicional: !!principal && principal !== p.id,
          activos: u?.activos ?? 0,
          pico: u?.pico ?? 0,
          diasExcedidos:
            linea?.maxActivos == null
              ? 0
              : (u?.serie ?? []).filter((d) => d.pico > (linea.maxActivos ?? 0))
                  .length,
          serie: u?.serie ?? [],
        };
      }),
      facturas,
      historial: historial.map((h: any) => ({
        accion: h.accion,
        entidad: h.entidad,
        detalle: h.detalle ?? null,
        fecha: new Date(h.fecha).toISOString(),
        usuario:
          h.firstName || h.lastName
            ? `${h.firstName ?? ''} ${h.lastName ?? ''}`.trim()
            : null,
      })),
    };
  }

  /**
   * Lo que ve el administrador de la empresa: su cuenta, el plan de cada playa, la lista de
   * planes para mostrarle dónde está parado, y sus pagos. Sin notas internas, sin quién registró
   * cada pago y sin el uso de la playa contra el límite: eso es del super admin.
   */
  async miPlan(empresaId: string) {
    const cuenta = await this.resumen(empresaId);
    const [playas, facturas, catalogo] = await Promise.all([
      this.dataSource.query(
        `SELECT id, nombre FROM playas WHERE "empresaId" = $1 ORDER BY nombre, id`,
        [empresaId],
      ),
      this.facturas(empresaId, 24),
      this.dataSource.query(
        `SELECT id, codigo, nombre, "maxActivos", "incluyeCocheras", "precioMensual", orden
         FROM planes WHERE activo OR id = ANY($1) ORDER BY orden, "precioMensual"`,
        [cuenta.planes.map((l) => l.planId)],
      ),
    ]);
    return {
      cuenta,
      playas: playas.map((p: any) => ({
        playaId: p.id,
        nombre: p.nombre,
        plan: cuenta.planes.find((l) => l.playaId === p.id) ?? null,
      })),
      catalogo: catalogo.map((p: any) => ({
        id: p.id,
        codigo: p.codigo,
        nombre: p.nombre,
        maxActivos: p.maxActivos === null ? null : Number(p.maxActivos),
        incluyeCocheras: !!p.incluyeCocheras,
        precioMensual: Number(p.precioMensual),
      })),
      // Una factura anulada sin haberse pagado es un recálculo interno (cambio de plan, días
      // extra): a la empresa no le dice nada. Un pago anulado sí se muestra.
      facturas: facturas
        .filter((f) => f.estado !== 'ANULADA' || f.pagadaEl)
        .map((f) => ({
          id: f.id,
          desde: f.desde,
          hasta: f.hasta,
          meses: f.meses,
          importe: f.importe,
          detalle: f.detalle,
          estado: f.estado,
          pagadaEl: f.pagadaEl,
          medio: f.medio,
          referencia: f.referencia,
        })),
    };
  }

  private async facturas(empresaId: string, limite: number) {
    const filas = await this.dataSource.query(
      `SELECT f.id, f.desde::text AS desde, f.hasta::text AS hasta, f.meses, f.importe, f.detalle,
              f.estado, f."pagadaEl"::text AS "pagadaEl", f.medio, f.referencia, f.nota,
              f."motivoAnulacion", f."anuladaEl", f."createdAt",
              NULLIF(TRIM(CONCAT(u."firstName", ' ', u."lastName")), '') AS "registradaPor"
       FROM facturas_saas f LEFT JOIN users u ON u.id = f."registradaPor"
       WHERE f."empresaId" = $1
       ORDER BY f.desde DESC, f."createdAt" DESC
       LIMIT $2`,
      [empresaId, limite],
    );
    return filas.map((f: any) => ({
      id: f.id as string,
      desde: f.desde as string,
      hasta: f.hasta as string,
      meses: Number(f.meses),
      importe: Number(f.importe),
      detalle: (f.detalle ?? []) as LineaFactura[],
      estado: f.estado as string,
      pagadaEl: f.pagadaEl as string | null,
      medio: f.medio as string | null,
      referencia: f.referencia as string | null,
      nota: f.nota as string | null,
      motivoAnulacion: f.motivoAnulacion as string | null,
      anuladaEl: f.anuladaEl ? new Date(f.anuladaEl).toISOString() : null,
      registradaPor: f.registradaPor as string | null,
    }));
  }

  /**
   * Estadías abiertas ahora y el pico de estadías abiertas a la vez de cada día de los últimos
   * `dias`. El pico sale de recorrer entradas (+1) y salidas (−1) en orden: a la misma hora la
   * salida va primero, para no inventar un pico con el auto que sale y el que entra.
   */
  async usoDePlayas(playaIds: string[], dias = 30) {
    const uso = new Map<
      string,
      { activos: number; pico: number; serie: { dia: string; pico: number }[] }
    >();
    if (!playaIds.length) return uso;
    const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
    const [abiertas, picos] = await Promise.all([
      this.dataSource.query(
        `SELECT "playaId", COUNT(*)::int AS activos FROM ticket_registrations
         WHERE "departureDay" IS NULL AND "playaId" = ANY($1) GROUP BY "playaId"`,
        [playaIds],
      ),
      this.dataSource.query(
        `WITH estadias AS (
           SELECT "playaId",
                  GREATEST(("entryDay" + COALESCE("entryTime", '00:00'::time)) AT TIME ZONE $3, $2::timestamptz) AS entra,
                  CASE WHEN "departureDay" IS NULL THEN NULL
                       ELSE ("departureDay" + COALESCE("departureTime", '00:00'::time)) AT TIME ZONE $3
                  END AS sale
           FROM ticket_registrations
           WHERE "playaId" = ANY($1) AND "entryDay" IS NOT NULL
             AND ("departureDay" IS NULL OR "departureDay" >= ($2::timestamptz AT TIME ZONE $3)::date - 1)
         ),
         validas AS (
           SELECT * FROM estadias WHERE sale IS NULL OR (sale > $2::timestamptz AND sale >= entra)
         ),
         eventos AS (
           SELECT "playaId", entra AS t, 1 AS d FROM validas
           UNION ALL
           SELECT "playaId", sale AS t, -1 AS d FROM validas WHERE sale IS NOT NULL
         ),
         corrida AS (
           SELECT "playaId", t,
                  SUM(d) OVER (PARTITION BY "playaId" ORDER BY t, d ROWS UNBOUNDED PRECEDING) AS abiertas
           FROM eventos
         )
         SELECT "playaId", (t AT TIME ZONE $3)::date::text AS dia, MAX(abiertas)::int AS pico
         FROM corrida GROUP BY "playaId", dia ORDER BY dia`,
        [playaIds, desde, ZONA],
      ),
    ]);
    for (const id of playaIds) {
      const serie = picos
        .filter((p: any) => p.playaId === id)
        .map((p: any) => ({ dia: p.dia as string, pico: Number(p.pico) }));
      uso.set(id, {
        activos: Number(
          abiertas.find((a: any) => a.playaId === id)?.activos ?? 0,
        ),
        pico: serie.reduce(
          (n: number, d: { pico: number }) => Math.max(n, d.pico),
          0,
        ),
        serie,
      });
    }
    return uso;
  }

  async planes() {
    const filas = await this.dataSource.query(
      `SELECT p.id, p.codigo, p.nombre, p."maxActivos", p."incluyeCocheras", p."precioMensual",
              p.activo, p.orden,
              COUNT(sp.id)::int AS playas, COUNT(DISTINCT sp."empresaId")::int AS empresas
       FROM planes p LEFT JOIN suscripcion_playas sp ON sp."planId" = p.id
       GROUP BY p.id ORDER BY p.orden, p."precioMensual"`,
    );
    return filas.map((p: any) => ({
      ...p,
      maxActivos: p.maxActivos === null ? null : Number(p.maxActivos),
      precioMensual: Number(p.precioMensual),
    }));
  }

  /** Pagos registrados en un rango de fechas, de todas las empresas. */
  async pagos(desde: string, hasta: string) {
    const filas = await this.dataSource.query(
      `SELECT f.id, f."empresaId", e.nombre AS empresa, f.importe, f.meses, f.medio, f.referencia,
              f."pagadaEl"::text AS "pagadaEl", f.desde::text AS desde, f.hasta::text AS hasta, f.estado
       FROM facturas_saas f JOIN empresas e ON e.id = f."empresaId"
       WHERE f.estado IN ('PAGADA', 'ANULADA') AND f."pagadaEl" BETWEEN $1 AND $2
       ORDER BY f."pagadaEl" DESC, f."createdAt" DESC`,
      [desde, hasta],
    );
    return filas.map((f: any) => ({
      ...f,
      importe: Number(f.importe),
      meses: Number(f.meses),
    }));
  }

  // ─── Escritura ──────────────────────────────────────────────────────────

  /**
   * Da de alta la cuenta: desde qué día es cliente y cuántos días de prueba gratis tiene. Al
   * terminar la prueba se emite la factura del primer mes. No hace falta tener plan: se elige
   * antes de que termine. Se puede volver a hacer mientras no haya pagado nunca.
   */
  async activar(
    empresaId: string,
    dto: ActivarCuentaDto,
    actor: string | null,
  ) {
    const hoy = hoyAR();
    if (diasEntre(hoy, dto.alta) > 60)
      throw new BadRequestException(
        'El alta no puede ser más de 60 días en el futuro.',
      );
    await this.enCuenta(empresaId, async (m, cuenta) => {
      if (cuenta.pagadoHasta)
        throw new BadRequestException({
          code: 'YA_PAGO',
          message:
            'Esta empresa ya tiene pagos: para darle más tiempo usá «Días extra».',
        });
      const pruebaHasta = finDePrueba(dto.alta, dto.diasPrueba);
      await m
        .getRepository(Suscripcion)
        .update({ empresaId }, { alta: dto.alta, pruebaHasta });
      const nueva = { ...cuenta, alta: dto.alta, pruebaHasta };
      await this.reactivarSiCorresponde(m, nueva, actor);
      await this.sincronizarPendiente(m, nueva);
      await this.auditar(m, empresaId, actor, 'SUSCRIPCION_ALTA', {
        alta: dto.alta,
        diasPrueba: dto.diasPrueba,
        pruebaHasta,
      });
    });
    return this.detalle(empresaId);
  }

  async asignarPlan(
    empresaId: string,
    playaId: string,
    dto: AsignarPlanDto,
    actor: string | null,
  ) {
    await this.enCuenta(empresaId, async (m, cuenta) => {
      const [playa] = await m.query(
        'SELECT id, nombre, modulos FROM playas WHERE id = $1 AND "empresaId" = $2',
        [playaId, empresaId],
      );
      if (!playa)
        throw new NotFoundException('La playa no es de esta empresa.');
      const plan = await m.getRepository(Plan).findOneBy({ id: dto.planId });
      if (!plan) throw new NotFoundException('Plan no encontrado.');
      const repo = m.getRepository(PlanDePlaya);
      const actual = await repo.findOne({
        where: { playaId },
        relations: ['plan'],
      });
      if (!plan.activo && actual?.planId !== plan.id)
        throw new BadRequestException({
          code: 'PLAN_RETIRADO',
          message: 'Ese plan ya no se ofrece. Elegí uno de los vigentes.',
        });
      // La primera playa con plan paga la lista; las demás, con el descuento de playa adicional.
      const principal = await this.playaPrincipal(m, empresaId);
      const adicional = !!principal && principal !== playaId;
      const precio =
        dto.precio ??
        (adicional
          ? Math.round(plan.precioMensual * (1 - DESCUENTO_PLAYA_ADICIONAL))
          : plan.precioMensual);
      await repo.save(
        repo.create({
          ...(actual ?? {}),
          empresaId,
          playaId,
          planId: plan.id,
          precio,
          // Corregir el precio no es cambiar de plan: la fecha queda la de cuando lo eligió.
          desde: actual?.planId === plan.id ? actual.desde : hoyAR(),
          plan,
        }),
      );
      // Los alquileres mensuales los define el plan: prende o apaga la sección Inquilinos.
      // Apagarla no borra nada, solo la oculta.
      if (!!playa.modulos?.inquilinos !== plan.incluyeCocheras)
        await m.query(
          `UPDATE playas SET modulos = COALESCE(modulos, '{}'::jsonb) || jsonb_build_object('inquilinos', $2::boolean),
                  "updatedAt" = now()
           WHERE id = $1`,
          [playaId, plan.incluyeCocheras],
        );
      await this.sincronizarPendiente(m, cuenta);
      await this.auditar(
        m,
        empresaId,
        actor,
        'SUSCRIPCION_PLAN',
        {
          playa: playa.nombre,
          plan: plan.nombre,
          precio,
          ...(actual
            ? {
                anterior: actual.plan?.nombre ?? null,
                precioAnterior: actual.precio,
              }
            : {}),
        },
        playaId,
      );
    });
    return this.detalle(empresaId);
  }

  async editar(
    empresaId: string,
    dto: EditarSuscripcionDto,
    actor: string | null,
  ) {
    await this.enCuenta(empresaId, async (m, cuenta) => {
      const cambios: Record<string, unknown> = {};
      const set: Partial<Suscripcion> = {};
      if (dto.alta !== undefined && dto.alta !== cuenta.alta) {
        if (diasEntre(hoyAR(), dto.alta) > 60)
          throw new BadRequestException(
            'El alta no puede ser más de 60 días en el futuro.',
          );
        set.alta = dto.alta;
        cambios.alta = dto.alta;
        cambios.altaAnterior = cuenta.alta;
        // Mientras no pagó, la prueba se cuenta desde el alta: se corre con ella y conserva sus
        // días. Con pagos, el alta es solo un dato: no reescribe períodos ya cobrados.
        if (!cuenta.pagadoHasta && cuenta.pruebaHasta) {
          set.pruebaHasta = sumarDias(
            cuenta.pruebaHasta,
            diasEntre(cuenta.alta, dto.alta),
          );
          cambios.pruebaHasta = set.pruebaHasta;
        }
      }
      if (
        dto.pagadoHasta !== undefined &&
        dto.pagadoHasta !== cuenta.pagadoHasta
      ) {
        set.pagadoHasta = dto.pagadoHasta;
        cambios.pagadoHasta = dto.pagadoHasta;
        cambios.pagadoHastaAnterior = cuenta.pagadoHasta;
      }
      if (
        dto.bonificada !== undefined &&
        dto.bonificada !== cuenta.bonificada
      ) {
        set.bonificada = dto.bonificada;
        cambios.bonificada = dto.bonificada;
      }
      if (dto.notas !== undefined) set.notas = dto.notas || null;
      if (!Object.keys(set).length) return;
      await m.getRepository(Suscripcion).update({ empresaId }, set);
      const nueva = { ...cuenta, ...set } as FilaCuenta;
      await this.reactivarSiCorresponde(m, nueva, actor);
      await this.sincronizarPendiente(m, nueva);
      // La nota interna se guarda sin dejar rastro de su texto: es del super admin para sí mismo.
      if (Object.keys(cambios).length)
        await this.auditar(m, empresaId, actor, 'SUSCRIPCION_EDITADA', cambios);
    });
    return this.detalle(empresaId);
  }

  /**
   * Más tiempo sin pagar, hasta `hasta`. Es una sola acción para el super admin, pero hace lo que
   * corresponde: si nunca pagó, alarga la prueba (y corre la primera factura); si ya paga, es una
   * prórroga: corre la suspensión sin mover el vencimiento, y los días de atraso se siguen
   * contando para la próxima factura.
   */
  async diasExtra(
    empresaId: string,
    hasta: string,
    motivo: string,
    actor: string | null,
  ) {
    const hoy = hoyAR();
    if (hasta < hoy)
      throw new BadRequestException(
        'Los días extra tienen que llegar por lo menos hasta hoy.',
      );
    if (diasEntre(hoy, hasta) > 90)
      throw new BadRequestException('No se pueden dar más de 90 días extra.');
    await this.enCuenta(empresaId, async (m, cuenta) => {
      if (!cuenta.pruebaHasta && !cuenta.pagadoHasta)
        throw new BadRequestException({
          code: 'SIN_ACTIVAR',
          message: 'Primero dale el alta a la cuenta.',
        });
      const set: Partial<Suscripcion> = cuenta.pagadoHasta
        ? { prorrogaHasta: hasta }
        : { pruebaHasta: hasta };
      if (
        !cuenta.pagadoHasta &&
        cuenta.pruebaHasta &&
        hasta <= cuenta.pruebaHasta
      )
        throw new BadRequestException(
          'La prueba ya llega hasta esa fecha: elegí una posterior.',
        );
      await m.getRepository(Suscripcion).update({ empresaId }, set);
      const nueva = { ...cuenta, ...set } as FilaCuenta;
      await this.reactivarSiCorresponde(m, nueva, actor);
      await this.sincronizarPendiente(m, nueva);
      await this.auditar(m, empresaId, actor, 'SUSCRIPCION_DIAS_EXTRA', {
        hasta,
        motivo,
        como: cuenta.pagadoHasta ? 'PRORROGA' : 'PRUEBA',
      });
    });
    return this.detalle(empresaId);
  }

  async registrarPago(
    empresaId: string,
    dto: RegistrarPagoSaasDto,
    actor: string | null,
  ) {
    const hoy = hoyAR();
    if (dto.fecha > hoy)
      throw new BadRequestException('La fecha del pago no puede ser futura.');
    await this.enCuenta(empresaId, (m, cuenta) =>
      this.asentarPago(m, cuenta, dto, actor),
    );
    return this.detalle(empresaId);
  }

  /**
   * Un pago que MercadoPago confirmó (débito automático o pago con MercadoPago). Llega por el
   * aviso, por la verificación al volver de pagar o por la revisión diaria, a veces más de uno a
   * la vez: se asienta una sola vez por id de pago (y el índice único es la última red). Se
   * registra lo que MercadoPago dice que entró, no lo que se pidió. Devuelve si lo asentó.
   */
  async acreditarPagoMercadoPago(
    empresaId: string,
    pago: { id: string; monto: number; fecha: string; debito: boolean },
  ) {
    let asentado = false;
    await this.enCuenta(empresaId, async (m, cuenta) => {
      const ya = await m
        .getRepository(FacturaSaas)
        .existsBy({ medio: 'MERCADOPAGO', referencia: pago.id });
      if (ya) return;
      const hoy = hoyAR();
      await this.asentarPago(
        m,
        cuenta,
        {
          meses: 1,
          importe: pago.monto,
          medio: 'MERCADOPAGO',
          fecha: pago.fecha > hoy ? hoy : pago.fecha,
          referencia: pago.id,
          nota: pago.debito ? 'Débito automático' : 'Pago con MercadoPago',
        },
        null,
      );
      asentado = true;
    });
    return asentado;
  }

  /** El débito automático de una empresa, tal como lo conoce la plataforma. */
  async datosDebito(empresaId: string) {
    const [fila] = await this.dataSource.query(
      `SELECT "debitoId", "debitoEstado", "debitoEmail", "debitoUrl", "debitoImporte"
       FROM suscripciones WHERE "empresaId" = $1`,
      [empresaId],
    );
    return {
      debitoId: (fila?.debitoId as string | null) ?? null,
      debitoEstado: (fila?.debitoEstado as DebitoEstado | null) ?? null,
      debitoEmail: (fila?.debitoEmail as string | null) ?? null,
      debitoUrl: (fila?.debitoUrl as string | null) ?? null,
      debitoImporte:
        fila?.debitoImporte == null ? null : Number(fila.debitoImporte),
    };
  }

  /** De qué empresa es una suscripción de MercadoPago (para los avisos). */
  async empresaDeDebito(debitoId: string) {
    const [fila] = await this.dataSource.query(
      'SELECT "empresaId" FROM suscripciones WHERE "debitoId" = $1',
      [debitoId],
    );
    return (fila?.empresaId as string | undefined) ?? null;
  }

  /**
   * Guarda lo que cambió del débito automático. Activarlo o darlo de baja queda en el historial;
   * los cambios de estado que informa MercadoPago, también.
   */
  async guardarDebito(
    empresaId: string,
    cambios: Partial<
      Pick<
        Suscripcion,
        | 'debitoId'
        | 'debitoEstado'
        | 'debitoEmail'
        | 'debitoUrl'
        | 'debitoImporte'
      >
    >,
    actor: string | null,
  ) {
    await this.enCuenta(empresaId, async (m, cuenta) => {
      await m.getRepository(Suscripcion).update({ empresaId }, cambios);
      if (
        cambios.debitoEstado &&
        cambios.debitoEstado !== cuenta.debitoEstado
      ) {
        await this.auditar(m, empresaId, actor, 'SUSCRIPCION_DEBITO', {
          estado: cambios.debitoEstado,
          email: cambios.debitoEmail ?? cuenta.debitoEmail,
        });
        // Con el débito autorizado la gracia es más larga: si la cuenta estaba cortada y ahora
        // entra en la gracia nueva, vuelve.
        await this.reactivarSiCorresponde(
          m,
          { ...cuenta, conDebito: cambios.debitoEstado === 'authorized' },
          actor,
        );
      }
    });
  }

  /** Las cuentas a las que vale la pena preguntarle a MercadoPago por pagos. */
  async cuentasParaConciliar() {
    const filas = await this.dataSource.query(
      `SELECT s."empresaId" FROM suscripciones s JOIN empresas e ON e.id = s."empresaId"
       WHERE e.estado <> 'BAJA' AND (
         s."debitoEstado" IN ('pending', 'authorized')
         OR EXISTS (SELECT 1 FROM facturas_saas f WHERE f."empresaId" = s."empresaId" AND f.estado = 'PENDIENTE')
       )`,
    );
    return filas.map((f: any) => f.empresaId as string);
  }

  /**
   * Asienta un pago: paga la factura pendiente si la hay (es la que la empresa vio en su panel)
   * o crea una, corre el vencimiento y reactiva una cuenta cortada por falta de pago.
   */
  private async asentarPago(
    m: EntityManager,
    cuenta: FilaCuenta,
    dto: RegistrarPagoSaasDto,
    actor: string | null,
  ) {
    const empresaId = cuenta.empresaId;
    const periodo = periodoDelPago(cuenta, dto.meses, hoyAR());
    const repo = m.getRepository(FacturaSaas);
    const pendiente = await repo.findOneBy({
      empresaId,
      estado: 'PENDIENTE',
    });
    const factura = repo.create({
      ...(pendiente ?? {}),
      empresaId,
      desde: periodo.desde,
      hasta: periodo.hasta,
      meses: dto.meses,
      importe: dto.importe,
      detalle: await this.lineasDeFactura(m, empresaId),
      estado: 'PAGADA' as const,
      pagadaEl: dto.fecha,
      medio: dto.medio,
      referencia: dto.referencia || null,
      nota: dto.nota || null,
      registradaPor: actor,
      pagadoHastaAnterior: cuenta.pagadoHasta,
    });
    await repo.save(factura);
    // Lo pagado llega más lejos que los días extra: ya no hacen falta.
    const prorrogaHasta =
      cuenta.prorrogaHasta && cuenta.prorrogaHasta > periodo.hasta
        ? cuenta.prorrogaHasta
        : null;
    await m
      .getRepository(Suscripcion)
      .update({ empresaId }, { pagadoHasta: periodo.hasta, prorrogaHasta });
    await this.reactivarSiCorresponde(
      m,
      { ...cuenta, pagadoHasta: periodo.hasta, prorrogaHasta },
      actor,
    );
    await this.auditar(m, empresaId, actor, 'SUSCRIPCION_PAGO', {
      importe: dto.importe,
      medio: dto.medio,
      meses: dto.meses,
      desde: periodo.desde,
      hasta: periodo.hasta,
      ...(dto.medio === 'MERCADOPAGO' && !actor ? { automatico: true } : {}),
    });
  }

  /**
   * Solo el último pago: es el único cuyo efecto se puede deshacer limpio (el vencimiento vuelve
   * a donde estaba). Si la cuenta queda vencida, la tarea diaria la suspende como a cualquiera.
   */
  async anularPago(
    empresaId: string,
    facturaId: string,
    motivo: string,
    actor: string | null,
  ) {
    await this.enCuenta(empresaId, async (m, cuenta) => {
      const repo = m.getRepository(FacturaSaas);
      const factura = await repo.findOneBy({ id: facturaId, empresaId });
      if (!factura) throw new NotFoundException('Pago no encontrado.');
      if (factura.estado !== 'PAGADA')
        throw new BadRequestException(
          'Solo se puede anular un pago registrado.',
        );
      if (factura.hasta !== cuenta.pagadoHasta)
        throw new BadRequestException({
          code: 'SOLO_ULTIMO_PAGO',
          message:
            'Solo se puede anular el último pago registrado. Anulá primero los posteriores.',
        });
      await repo.update(
        { id: factura.id },
        {
          estado: 'ANULADA',
          motivoAnulacion: motivo,
          anuladaEl: new Date(),
          anuladaPor: actor,
        },
      );
      await m
        .getRepository(Suscripcion)
        .update({ empresaId }, { pagadoHasta: factura.pagadoHastaAnterior });
      await this.sincronizarPendiente(m, {
        ...cuenta,
        pagadoHasta: factura.pagadoHastaAnterior,
      });
      await this.auditar(m, empresaId, actor, 'SUSCRIPCION_PAGO_ANULADO', {
        importe: factura.importe,
        desde: factura.desde,
        hasta: factura.hasta,
        motivo,
      });
    });
    return this.detalle(empresaId);
  }

  /** Lo llama el panel después de suspender, reactivar o dar de baja a mano. */
  async cambioManualDeEstado(empresaId: string, estado: EmpresaEstado) {
    await this.dataSource.query(
      `INSERT INTO suscripciones ("empresaId") VALUES ($1) ON CONFLICT ("empresaId") DO NOTHING`,
      [empresaId],
    );
    await this.dataSource
      .getRepository(Suscripcion)
      .update(
        { empresaId },
        estado === 'ACTIVA'
          ? { motivoSuspension: null, suspendidaEl: null }
          : { motivoSuspension: 'MANUAL', suspendidaEl: new Date() },
      );
  }

  async editarPlan(id: string, dto: EditarPlanDto) {
    const repo = this.dataSource.getRepository(Plan);
    const plan = await repo.findOneBy({ id });
    if (!plan) throw new NotFoundException('Plan no encontrado.');
    await repo.save(repo.merge(plan, dto));
    return this.planes();
  }

  // ─── Tarea diaria ───────────────────────────────────────────────────────

  /**
   * Emite la factura del período que empieza (el día en que vence), suspende lo que lleva más de
   * DIAS_DE_GRACIA de atraso y da de baja lo que lleva mucho suspendido por falta de pago. Es
   * idempotente: correrla dos veces el mismo día no hace nada la segunda, y dos instancias a la
   * vez se ordenan por el lock.
   */
  async revisarVencimientos(hoy = hoyAR()) {
    const resultado = { suspendidas: 0, bajas: 0, facturas: 0 };
    await this.dataSource.transaction(async (m) => {
      const [{ tomado }] = await m.query(
        `SELECT pg_try_advisory_xact_lock(hashtext('suscripciones:revision')) AS tomado`,
      );
      if (!tomado) return;
      await m.query(
        `INSERT INTO suscripciones ("empresaId") SELECT id FROM empresas ON CONFLICT ("empresaId") DO NOTHING`,
      );
      const cuentas: FilaCuenta[] = await m.query(
        `SELECT s."empresaId", ${CAMPOS_CUENTA}
         FROM suscripciones s JOIN empresas e ON e.id = s."empresaId"
         FOR UPDATE OF s`,
      );
      const limiteBaja = Date.now() - DIAS_HASTA_BAJA * 24 * 60 * 60 * 1000;
      for (const cuenta of cuentas) {
        if (await this.sincronizarPendiente(m, cuenta, hoy))
          resultado.facturas++;
        const situacion = situacionDeCuenta(cuenta, hoy);
        if (cuenta.empresaEstado === 'ACTIVA' && situacion.debeSuspenderse) {
          await m.query(
            `UPDATE empresas SET estado = 'SUSPENDIDA', "updatedAt" = now() WHERE id = $1`,
            [cuenta.empresaId],
          );
          await m
            .getRepository(Suscripcion)
            .update(
              { empresaId: cuenta.empresaId },
              { motivoSuspension: 'FALTA_DE_PAGO', suspendidaEl: new Date() },
            );
          await this.auditar(m, cuenta.empresaId, null, 'EMPRESA_SUSPENDIDA', {
            motivo: 'FALTA_DE_PAGO',
            vencio: situacion.proximoVencimiento,
            diasDeAtraso: situacion.diasDeAtraso,
          });
          resultado.suspendidas++;
        } else if (
          cuenta.empresaEstado === 'SUSPENDIDA' &&
          cuenta.motivoSuspension === 'FALTA_DE_PAGO' &&
          cuenta.suspendidaEl &&
          new Date(cuenta.suspendidaEl).getTime() < limiteBaja
        ) {
          await m.query(
            `UPDATE empresas SET estado = 'BAJA', "updatedAt" = now() WHERE id = $1`,
            [cuenta.empresaId],
          );
          await this.auditar(m, cuenta.empresaId, null, 'EMPRESA_BAJA', {
            motivo: 'FALTA_DE_PAGO',
            dias: DIAS_HASTA_BAJA,
          });
          resultado.bajas++;
        }
      }
    });
    if (resultado.suspendidas || resultado.bajas || resultado.facturas)
      this.logger.log(
        `Revisión de cuentas: ${resultado.suspendidas} suspendidas, ${resultado.bajas} bajas, ${resultado.facturas} facturas emitidas.`,
      );
    return resultado;
  }

  // ─── Internos ───────────────────────────────────────────────────────────

  /** Bloquea la cuenta de la empresa (creándola si falta) y corre `fn` en esa transacción. */
  private async enCuenta(
    empresaId: string,
    fn: (m: EntityManager, cuenta: FilaCuenta) => Promise<void>,
  ) {
    await this.dataSource.transaction(async (m) => {
      const [empresa] = await m.query('SELECT id FROM empresas WHERE id = $1', [
        empresaId,
      ]);
      if (!empresa) throw new NotFoundException('Empresa no encontrada.');
      await m.query(
        `INSERT INTO suscripciones ("empresaId", alta)
         SELECT id, ((e."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE '${ZONA}')::date
         FROM empresas e WHERE e.id = $1
         ON CONFLICT ("empresaId") DO NOTHING`,
        [empresaId],
      );
      const [cuenta] = await m.query(
        `SELECT s."empresaId", ${CAMPOS_CUENTA}
         FROM suscripciones s JOIN empresas e ON e.id = s."empresaId"
         WHERE s."empresaId" = $1
         FOR UPDATE OF s`,
        [empresaId],
      );
      await fn(m, cuenta);
    });
  }

  /** La primera playa de la empresa que tuvo plan: la única que paga precio de lista. */
  private async playaPrincipal(m: EntityManager, empresaId: string) {
    const [fila] = await m.query(
      `SELECT "playaId" FROM suscripcion_playas WHERE "empresaId" = $1
       ORDER BY "createdAt", id LIMIT 1`,
      [empresaId],
    );
    return (fila?.playaId as string | undefined) ?? null;
  }

  /**
   * Una cuenta cortada por falta de pago vuelve sola cuando deja de estar vencida (pagó, se le
   * dieron días extra, se le corrió el alta). Una suspensión manual no: esa la levanta una persona.
   */
  private async reactivarSiCorresponde(
    m: EntityManager,
    cuenta: FilaCuenta,
    actor: string | null,
  ) {
    if (!cortadaPorFaltaDePago(cuenta)) return;
    const situacion = situacionDeCuenta({ ...cuenta, empresaEstado: 'ACTIVA' });
    if (situacion.debeSuspenderse) return;
    await m.query(
      `UPDATE empresas SET estado = 'ACTIVA', "updatedAt" = now() WHERE id = $1`,
      [cuenta.empresaId],
    );
    await m
      .getRepository(Suscripcion)
      .update(
        { empresaId: cuenta.empresaId },
        { motivoSuspension: null, suspendidaEl: null },
      );
    await this.auditar(m, cuenta.empresaId, actor, 'EMPRESA_REACTIVADA', {
      motivo: 'REGULARIZADA',
    });
  }

  private async lineasDeFactura(
    m: EntityManager,
    empresaId: string,
  ): Promise<LineaFactura[]> {
    const filas = await m.query(
      `SELECT sp."playaId", pl.nombre AS playa, sp."planId", p.nombre AS plan, sp.precio
       FROM suscripcion_playas sp
       JOIN planes p ON p.id = sp."planId"
       JOIN playas pl ON pl.id = sp."playaId"
       WHERE sp."empresaId" = $1 ORDER BY pl.nombre, pl.id`,
      [empresaId],
    );
    return filas.map((f: any) => ({ ...f, precio: Number(f.precio) }));
  }

  /**
   * Mantiene la factura pendiente igual a la cuenta. Se emite el día en que empieza el período
   * (al terminar la prueba o lo pagado), con ese día como vencimiento; mientras no se pague, su
   * importe sigue al plan y su período a las fechas de la cuenta. Si ya no corresponde
   * (bonificada, sin plan, se le dieron días de prueba) se anula con el motivo.
   *
   * El período no se corre aunque la cuenta esté cortada: la factura tiene que seguir diciendo
   * desde cuándo debe. Recién al pagar se decide desde qué día cubre (periodoDelPago).
   *
   * Devuelve si emitió una factura nueva.
   */
  private async sincronizarPendiente(
    m: EntityManager,
    cuenta: FilaCuenta,
    hoy = hoyAR(),
  ) {
    const repo = m.getRepository(FacturaSaas);
    const pendiente = await repo.findOneBy({
      empresaId: cuenta.empresaId,
      estado: 'PENDIENTE',
    });
    const detalle = await this.lineasDeFactura(m, cuenta.empresaId);
    const importe = detalle.reduce((n, l) => n + l.precio, 0);
    const venceEl = cuenta.pagadoHasta ?? cuenta.pruebaHasta;
    const corresponde =
      correspondeFactura(cuenta, hoy) && importe > 0 && !!venceEl;
    if (!corresponde) {
      if (pendiente)
        await repo.update(
          { id: pendiente.id },
          {
            estado: 'ANULADA',
            motivoAnulacion: 'Se recalculó la cuenta antes del vencimiento.',
            anuladaEl: new Date(),
          },
        );
      return false;
    }
    const periodo = periodoSiguiente(venceEl);
    if (pendiente) {
      await repo.update(
        { id: pendiente.id },
        {
          desde: periodo.desde,
          hasta: periodo.hasta,
          importe,
          detalle,
          meses: 1,
        },
      );
      return false;
    }
    await repo.save(
      repo.create({
        empresaId: cuenta.empresaId,
        desde: periodo.desde,
        hasta: periodo.hasta,
        meses: 1,
        importe,
        detalle,
        estado: 'PENDIENTE',
      }),
    );
    return true;
  }

  private async auditar(
    m: EntityManager,
    empresaId: string,
    usuarioId: string | null,
    accion: string,
    detalle: Record<string, unknown>,
    playaId: string | null = null,
  ) {
    await m.getRepository(AuditLog).insert({
      empresaId,
      usuarioId,
      playaId,
      accion,
      entidad: 'cuenta',
      entidadId: empresaId,
      detalle,
    });
  }
}
