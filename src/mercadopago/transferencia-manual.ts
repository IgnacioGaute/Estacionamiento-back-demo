import { ForbiddenException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { operationContext } from 'src/common/operation-context';
import { tenantContext } from 'src/tenancy/tenant-context';
import { VERSION_VERIFICACION_ALIAS, aceptoAlMenos } from './condiciones';

// «Transferencia» a secas es lo único digital que se registra por la palabra del operador: nadie
// comprueba que la plata entró, y cargar como transferencia un pago en efectivo deja la caja
// cuadrada sin la plata. Con la verificación por alias activa, el que transfiere lo hace al alias y
// el sistema lo detecta solo, así que el operador ya no la tiene. La administración sí (casos raros:
// una transferencia a otra cuenta), y queda listada en «Para revisar» del cierre.

/** Las mismas tres llaves que VerificacionAliasService.habilitacion, en una consulta. */
export async function aliasActivo(m: EntityManager, empresaId: string) {
  const [fila] = await m.query(
    `SELECT c."condicionesVersion" FROM mercadopago_cuentas c
      WHERE c."empresaId" = $1 AND c.estado = 'ACTIVA' AND c."accessToken" IS NOT NULL
        AND c."verificacionAlias" AND c.alias IS NOT NULL
        AND EXISTS (SELECT 1 FROM empresa_adicionales a
          WHERE a."empresaId" = $1 AND a.codigo = 'VERIFICACION_ALIAS' AND a.habilitado)`,
    [empresaId],
  );
  return !!fila && aceptoAlMenos(fila.condicionesVersion, VERSION_VERIFICACION_ALIAS);
}

export const esAdministracion = (rol?: string) => rol === 'ADMIN' || rol === 'SUPER_ADMIN';

/** Si quien está en la playa puede registrar una transferencia sin verificar. */
export async function transferenciaManualPermitida(m: EntityManager) {
  const scope = tenantContext.getStore();
  if (!scope?.empresaId || esAdministracion(scope.role)) return true;
  return !(await aliasActivo(m, scope.empresaId));
}

/**
 * Antes de guardar un cobro. `confirmadoPorMercadoPago`: lo registra la confirmación de un QR o de
 * una transferencia al alias, no el operador. Las devoluciones y reversiones (importe negativo) y
 * lo que llega sin conexión (se cobró antes de poder verificar) pasan siempre.
 */
export async function exigirTransferenciaPermitida(
  m: EntityManager,
  metodo: string | null | undefined,
  importe: number,
  confirmadoPorMercadoPago: boolean,
) {
  if (metodo !== 'TRANSFER' || !(importe > 0) || confirmadoPorMercadoPago) return;
  if (operationContext.getStore()) return;
  if (await transferenciaManualPermitida(m)) return;
  throw new ForbiddenException({
    code: 'TRANSFERENCIA_CON_ALIAS',
    message:
      'Con el alias activo, las transferencias se cobran «Al alias»: el sistema las detecta solas. Si el cliente transfirió a otra cuenta, avisale al administrador.',
  });
}
