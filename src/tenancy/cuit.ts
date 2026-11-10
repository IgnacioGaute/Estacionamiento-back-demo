import { ValidateBy, ValidationOptions } from 'class-validator';

// CUIT/CUIL argentino: 11 números, el último es un dígito verificador. Se guarda sin guiones y la
// pantalla lo muestra como 30-12345678-9. Validar el verificador evita el error más común al
// copiarlo: un número cambiado.

const PESOS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** «30-71234567-1», «30 71234567 1» o «30.71234567.1» → «30712345671». Lo demás queda igual. */
export const normalizarCuit = (valor: unknown) =>
  typeof valor === 'string' ? valor.replace(/[\s.-]/g, '') : valor;

export function cuitValido(cuit: string) {
  if (!/^\d{11}$/.test(cuit)) return false;
  const suma = PESOS.reduce((total, peso, i) => total + peso * Number(cuit[i]), 0);
  const resto = 11 - (suma % 11);
  const verificador = resto === 11 ? 0 : resto;
  // Con resto 10 el número no se asigna: AFIP cambia el prefijo en vez de usar ese verificador.
  return verificador !== 10 && verificador === Number(cuit[10]);
}

export function EsCuit(opciones?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'esCuit',
      validator: {
        validate: (valor) => typeof valor === 'string' && cuitValido(valor),
        defaultMessage: () => 'El CUIT no es válido: revisá los 11 números.',
      },
    },
    opciones,
  );
}
