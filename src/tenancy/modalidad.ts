import { ConflictException, ForbiddenException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { tenantContext } from './tenant-context';

/**
 * Modalidad de operación de una playa. «Con cobro» es el funcionamiento de siempre; «Gratuito»
 * registra y controla vehículos sin tarifas ni dinero. La define solo el super admin
 * (TenancyService.cambiarModalidad) y es independiente del plan SaaS: una playa gratuita para sus
 * visitantes igual paga por usar el sistema.
 *
 * Cada estadía guarda la modalidad con la que ingresó (`ticket_registrations.modalidad`) y sale con
 * esa: un cambio de configuración nunca reinterpreta lo que ya está adentro.
 *
 * Todas las restricciones salen de acá para no repartir condiciones:
 * - FREE_MODE_BLOCKED (endpoint-policy.ts): el TenantInterceptor corta los endpoints financieros.
 * - exigirCobro: lo llaman los embudos de dinero dentro de su transacción (caja, movimientos,
 *   turnos, cobros QR/alias), así una operación que empezó antes del cambio no se cuela después.
 * - modalidadParaIngreso: el ingreso decide con qué modalidad nace la estadía.
 */
export const MODALIDADES = ['CON_COBRO', 'GRATUITO'] as const;
export type Modalidad = (typeof MODALIDADES)[number];

export const esGratuita = (modalidad?: string | null) => modalidad === 'GRATUITO';

export const modalidadGratuita = () =>
  new ForbiddenException({
    code: 'MODALIDAD_GRATUITA',
    message: 'Esta playa funciona en modalidad gratuita: no registra tarifas, cobros ni caja.',
  });

export const estadiaGratuita = () =>
  new ConflictException({
    code: 'ESTADIA_GRATUITA',
    message: 'Esta estadía ingresó en modalidad gratuita: no tiene importes. Registrá la salida sin cobro.',
  });

export const estadiaConCobro = () =>
  new ConflictException({
    code: 'ESTADIA_CON_COBRO',
    message: 'Esta estadía ingresó con cobro: registrá la salida desde Cobrar salida.',
  });

/** Lectura sin bloqueo propio: para quien ya tomó 718903 o 718904 exclusivos (offline). */
export async function leerModalidad(m: EntityManager, playaId: string): Promise<Modalidad> {
  return leer(m, playaId);
}

async function leer(m: EntityManager, playaId: string): Promise<Modalidad> {
  const rows = await m.query('SELECT modalidad FROM playas WHERE id = $1', [playaId]);
  return esGratuita(rows?.[0]?.modalidad) ? 'GRATUITO' : 'CON_COBRO';
}

/**
 * La modalidad con la que nace un ingreso. Toma compartido el mismo bloqueo de tarifas que la
 * captura del snapshot (718903); el cambio de modalidad lo toma exclusivo, así que un ingreso
 * en curso termina antes del cambio (y el cambio lo ve) o empieza después (y ve la nueva).
 */
export async function modalidadParaIngreso(m: EntityManager): Promise<Modalidad> {
  const playaId = tenantContext.getStore()?.playaId;
  if (!playaId) return 'CON_COBRO';
  await m.query('SELECT pg_advisory_xact_lock_shared(718903)');
  return leer(m, playaId);
}

/**
 * Corta una operación de dinero en una playa gratuita. Toma el bloqueo de caja (718904) exclusivo,
 * como ya lo toman cobros, cierres y turnos: si la operación ya lo tiene, se concede en el acto, y
 * no hay que subir de compartido a exclusivo más adelante (dos cierres simultáneos que lo hicieran
 * se bloquearían entre sí). El cambio de modalidad también lo toma. Sin playa en el scope
 * (procesos legacy sin tenant) no hay modalidad que validar.
 */
export async function exigirCobro(m: EntityManager) {
  const playaId = tenantContext.getStore()?.playaId;
  if (!playaId) return;
  await m.query('SELECT pg_advisory_xact_lock(718904)');
  if ((await leer(m, playaId)) === 'GRATUITO') throw modalidadGratuita();
}
