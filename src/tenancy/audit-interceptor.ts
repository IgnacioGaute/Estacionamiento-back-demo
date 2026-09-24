import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { DataSource } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { tenantContext } from './tenant-context';
import { AUDIT_RULES, AuditRule } from './audit-policy';

// Registra en audit_log los cambios de administración descriptos en audit-policy.ts.
//
// Va como interceptor y no repartido por los servicios por dos motivos: los servicios siguen sin
// saber nada de auditoría, y qué se audita se lee de un solo archivo en vez de buscarlo en veinte.
// Corre DESPUÉS del TenantInterceptor, así que el scope de empresa y playa ya está resuelto.
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(private readonly ds: DataSource) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const regla =
      AUDIT_RULES[context.getClass().name]?.[context.getHandler().name];
    if (!regla) return next.handle();

    const req = context.switchToHttp().getRequest();
    // El scope se toma acá, mientras el contexto sigue activo, y no dentro del tap.
    const scope = tenantContext.getStore();
    if (!scope?.empresaId) return next.handle();

    // El estado anterior se lee ANTES de que el handler lo pise. Si falla, se sigue igual: se
    // registra el cambio sin el «de», que es mejor que no registrar nada.
    const previo = regla.previo
      ? await this.leerPrevio(regla, req, scope.playaId).catch(() => null)
      : null;

    return next.handle().pipe(
      // Solo el camino feliz: si el handler rechaza, no hubo cambio que registrar.
      tap((respuesta) => {
        const detalle = this.diferencias(regla, req.body, previo);

        this.ds
          .getRepository(AuditLog)
          .insert({
            empresaId: scope.empresaId,
            playaId: scope.playaId ?? null,
            usuarioId: scope.userId ?? null,
            accion: regla.accion,
            entidad: regla.entidad,
            // Cada controlador nombra su parámetro distinto (`id`, `code`, `parkingTypeId`…):
            // si no hay uno conocido se toma el primero que venga, y si no, el id del resultado.
            entidadId:
              req.params?.id ??
              req.params?.code ??
              Object.values(req.params ?? {})[0] ??
              (respuesta && typeof respuesta === 'object'
                ? ((respuesta as any).id ?? null)
                : null),
            detalle: Object.keys(detalle).length ? detalle : null,
          })
          // Nunca hace fallar la respuesta: el cambio ya se guardó y perderlo sería peor que
          // perder su rastro.
          .catch((error) =>
            this.logger.warn(
              `No se pudo registrar la auditoría ${regla.accion}: ${error?.message ?? error}`,
            ),
          );
      }),
    );
  }

  private async leerPrevio(
    regla: AuditRule,
    req: any,
    playaId?: string,
  ): Promise<Record<string, unknown> | null> {
    const tabla = `"${regla.previo!.tabla.replace(/"/g, '')}"`;
    if (regla.previo!.por === 'playa') {
      if (!playaId) return null;
      const [fila] = await this.ds.query(
        `SELECT * FROM ${tabla} WHERE "playaId" = $1 LIMIT 1`,
        [playaId],
      );
      return fila ?? null;
    }
    const id = req.params?.id ?? Object.values(req.params ?? {})[0];
    if (!id) return null;
    const [fila] = await this.ds.query(
      `SELECT * FROM ${tabla} WHERE id = $1 LIMIT 1`,
      [id],
    );
    return fila ?? null;
  }

  // Qué cambió realmente. El panel manda la sección entera en cada guardado, así que sin comparar
  // contra lo anterior el historial diría «cambió la configuración» y listaría los veinte campos,
  // iguales incluidos.
  //
  // Se compara hasta la hoja: interesa «desactivó el QR de los comprobantes», no «cambió la
  // entrega de comprobantes» con el objeto entero al lado. Las listas se comparan como una sola
  // hoja: qué cambió adentro de una lista de topes no se lee de un historial.
  private diferencias(
    regla: AuditRule,
    body: any,
    previo: Record<string, unknown> | null,
  ): Record<string, unknown> {
    const salida: Record<string, unknown> = {};
    if (!body) return salida;

    const hojas = (valor: unknown, prefijo: string, destino: Map<string, unknown>) => {
      if (
        valor &&
        typeof valor === 'object' &&
        !Array.isArray(valor) &&
        !(valor instanceof Date)
      ) {
        for (const [clave, dentro] of Object.entries(valor))
          hojas(dentro, prefijo ? `${prefijo}.${clave}` : clave, destino);
        return;
      }
      destino.set(prefijo, valor);
    };

    for (const campo of regla.campos ?? []) {
      const nuevo = body[campo];
      if (nuevo === undefined) continue;

      const nuevas = new Map<string, unknown>();
      hojas(nuevo, campo, nuevas);
      // Sin estado anterior (un alta) se guarda el valor tal cual: no hay con qué compararlo.
      if (!previo) {
        for (const [ruta, valor] of nuevas) salida[ruta] = valor;
        continue;
      }
      const viejas = new Map<string, unknown>();
      hojas(previo[campo], campo, viejas);
      for (const [ruta, valor] of nuevas) {
        const antes = viejas.get(ruta);
        if (JSON.stringify(valor) !== JSON.stringify(antes))
          salida[ruta] = { de: antes ?? null, a: valor };
      }
    }
    return salida;
  }
}
