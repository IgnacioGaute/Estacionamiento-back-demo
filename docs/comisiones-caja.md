# Comisiones estimadas de caja

Cada empresa configura sus porcentajes en Configuración → Mercado Pago → Comisiones.
La pantalla y el cálculo están disponibles sólo con una cuenta ACTIVA vinculada.
Los tickets, precios, saldos del cliente y arqueo conservan sus importes originales.

Hay seis tasas: QR saldo/transferencia, QR débito, QR crédito, alias transferencia,
alias débito y alias crédito. Se admite 0–100, hasta cuatro decimales; null significa
«a definir», mientras 0 significa expresamente sin descuento.

Referencias consultadas el 08/10/2026 para acreditación inmediata, con IVA 21%:
QR saldo 0,968%, débito 1,6335%, crédito en un pago 7,2479%.
Fuente: https://www.mercadopago.com.ar/herramientas-para-vender/cobrar-con-qr
Son estimaciones: provincia, cuotas y plazo pueden cambiar el costo real.
Alias transferencia y alias débito parten de 0% editable; para alias crédito no se
verificó una tarifa argentina para el receptor y se deja a definir.

La clasificación requiere evidencia del cobro acreditado de Mercado Pago o de una
transferencia verificada y usada en esa playa. Se conserva payment_type_id o
payment_method.type. No se deduce la tarjeta usada para fondear una transferencia:
bank_transfer se clasifica como transferencia. Los datos ausentes o tipos no
reconocidos quedan pendientes. Las transferencias manuales no llevan comisión MP.
Los cobros históricos sin tipo informado también quedan pendientes.

La respuesta de la planilla agrega medioPagoDetalle a cada movimiento, abono y cobro
de inquilino respaldado por esa evidencia. La vista y las filas del PDF muestran,
por ejemplo, «QR · crédito» o «Alias MP · crédito», sin modificar el método contable.
Las transferencias manuales no reciben estas etiquetas.

Cada operación verificada incluye comisionPagoEstimada (bruto, porcentaje, comisión,
neto y pendiente). Las filas del PDF usan TR QR y TR Alias. El neto digital se muestra
por igual en entradas y salidas, por lo que nunca aporta efectivo al subtotal. Las
devoluciones digitales revierten ambas columnas y no presumen devolución de comisión.
La vista conserva el efectivo como total principal. «Totales de comisión» se abre
desde una línea discreta; omite los medios con tasa 0%. El PDF conserva un resumen
compacto sólo de comisiones aplicadas o pendientes y no suma digital al efectivo.

El desglose de comisiones muestra bruto, comisión estimada y neto digital estimado.
La comisión se redondea por ingreso a centavos. Los egresos se restan completos,
sin presumir reintegros de comisión. No se duplica una imputación de cuenta corriente.
Los importes pendientes siguen incluidos sin descuento y el neto se marca parcial.
Los porcentajes actuales recalculan incluso fechas anteriores; no representan una
liquidación ni cargos reales informados por Mercado Pago.

GET /box-lists/comisiones devuelve conectada, tasas y referencia para la empresa de
la sesión. PATCH exige ADMIN y cuenta activa; recibe las seis tasas y no empresaId.
La migración 1790000033000 agrega empresas.comisionesMp y paymentTypeId en cobros
y transferencias. Conserva tasas anteriores no nulas y mayores que cero; en el resto
usa referencias iniciales. No inventa tipos para pagos históricos. Mantiene RLS y
los permisos limitados de parking_scoped.
