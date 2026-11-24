// Lo que hace la pantalla del mostrador, para las pruebas que cubren otras reglas de caja y cobro:
// - el arqueo final se cuenta por billetes: si la llamada trae solo el total, se arma un desglose
//   con ese total (y con el primer conteo, si fue otro);
// - un cobro en efectivo declara lo recibido: si la llamada no lo trae, se toca «Justo».
// Solo completa lo que falta y nunca dentro de una operación sin conexión que se sincroniza (esas
// prueban justamente los pendientes guardados sin estos datos). Las reglas nuevas tienen sus propias
// pruebas sin este ayudante (cajas.integration.cjs, tickets.integration.cjs).
const { operationContext } = require('../dist/common/operation-context');
const { DENOMINACIONES } = require('../dist/turnos/conteo-billetes');

function billetes(total) {
  let resto = total;
  const desglose = [];
  for (const denominacion of DENOMINACIONES) {
    const cantidad = Math.floor(resto / denominacion);
    if (cantidad) desglose.push({ denominacion, cantidad });
    resto -= cantidad * denominacion;
  }
  return desglose;
}

function efectivoDelCierre(dto) {
  if (dto.closeType !== 'PAYMENT') return 0;
  if (dto.pagos?.length) return dto.pagos.filter(p => p.metodo === 'CASH').reduce((s, p) => s + p.importe, 0);
  return dto.metodo === 'CASH' ? Math.max(0, dto.expectedPrice - dto.expectedCollected) : 0;
}

function comoMostrador({ tickets, shifts }) {
  const envolver = (servicio, metodo, completar) => {
    if (!servicio) return;
    const original = servicio[metodo].bind(servicio);
    servicio[metodo] = (...args) => {
      if (!operationContext.getStore()) completar(args);
      return original(...args);
    };
  };
  envolver(shifts, 'close', ([, , dto]) => {
    // La pantalla obliga a elegir cuánto se deja; las pruebas que no lo dicen dejan $0.
    if (dto && dto.efectivoContado !== undefined && dto.efectivoParaSiguiente === undefined) dto.efectivoParaSiguiente = 0;
    if (!dto || dto.desglose !== undefined || dto.efectivoContado === undefined) return;
    dto.desglose = billetes(dto.efectivoContado);
    if (dto.primerConteo !== undefined && dto.primerConteo !== dto.efectivoContado) dto.primerConteoDesglose = billetes(dto.primerConteo);
  });
  for (const metodo of ['closeRegistrationByPlate', 'registrarSalidaAnterior'])
    envolver(tickets, metodo, ([, dto]) => {
      const efectivo = dto ? efectivoDelCierre(dto) : 0;
      if (efectivo > 0 && dto.efectivoRecibido === undefined) dto.efectivoRecibido = efectivo;
    });
  envolver(tickets, 'cobrarParteEnEfectivo', ([, dto]) => {
    if (dto && dto.efectivoRecibido === undefined) dto.efectivoRecibido = dto.importe;
  });
}

module.exports = { comoMostrador, billetes };
