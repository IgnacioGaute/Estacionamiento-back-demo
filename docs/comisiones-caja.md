# Comisiones estimadas de caja

Cada empresa configura en Configuración → Mercado Pago dos porcentajes finales
(IVA incluido si corresponde): Mercado Pago/QR y transferencias/alias. Inicialmente
son 0%, con rango 0–100 y hasta dos decimales. La tasa de transferencias incluye las
verificadas y las manuales; no se infiere la tarjeta usada para fondear una transferencia.

Los porcentajes actuales recalculan la fecha consultada, incluso fechas anteriores.
Son una estimación editable, no una liquidación ni un registro de cargos reales de MP.
No se guardan en los tickets ni modifican movimientos, saldos del cliente o el arqueo.

La planilla y su PDF muestran efectivo, movimientos digitales antes de comisión,
comisiones estimadas y total neto estimado. El total general suma el efectivo neto
del día y los movimientos digitales netos, descontando la comisión por cada ingreso
(redondeada a centavos). Los egresos se restan completos sin presumir reintegros de
comisiones. Las imputaciones de un pago a recibos no vuelven a sumarse cuando ya
están representadas en la cuenta corriente.

GET /box-lists/comisiones consulta la empresa de la sesión. PATCH sobre la misma
ruta acepta qrPorcentaje y transferenciaPorcentaje y exige ADMIN. No acepta un
empresaId del cliente. La tabla empresas conserva su aislamiento RLS. La migración
1790000032000 agrega las columnas con valor cero y valida el rango en PostgreSQL.
