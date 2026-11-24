// Lo que hace la pantalla del mostrador, para las pruebas que cubren otras reglas de caja y cobro:
// al cerrar la caja obliga a elegir cuánto se deja; si la llamada no lo dice, se dejan $0. El total
// contado se puede escribir directo (contar por billetes es una alternativa) y lo recibido en
// efectivo es opcional: eso no se completa. Nunca dentro de una operación sin conexión que se
// sincroniza. `billetes` arma un desglose para las pruebas que cuentan por billetes.
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
    if (dto && dto.efectivoContado !== undefined && dto.efectivoParaSiguiente === undefined) dto.efectivoParaSiguiente = 0;
  });
}

module.exports = { comoMostrador, billetes };
