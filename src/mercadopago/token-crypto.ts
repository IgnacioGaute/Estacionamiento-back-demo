import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Los tokens de MercadoPago de cada empresa se guardan cifrados. Con un token en texto plano
// alcanza para cobrar en nombre del cliente, así que cualquiera que llegue a leer la base —un
// backup, un dump, una consulta de soporte— podría hacerlo. Es la primera credencial por inquilino
// del sistema: las demás claves de terceros (Cloudinary, Gemini, Plate Recognizer) son del proceso
// y viven en el entorno, no en la base.
//
// AES-256-GCM y no AES-CBC porque además de cifrar autentica: si alguien edita el texto guardado,
// el descifrado falla en vez de devolver basura que después se manda a MercadoPago.
//
// La clave va en MERCADOPAGO_TOKEN_KEY, 32 bytes en hexadecimal (`openssl rand -hex 32`). No se
// deriva de NEXTAUTH_SECRET a propósito: rotar el secreto de las sesiones no debería dejar
// ilegibles los tokens de cobro de todos los clientes.

const FORMATO = 'v1';
const BYTES_DE_CLAVE = 32;

function clave(): Buffer {
  const crudo = (process.env.MERCADOPAGO_TOKEN_KEY ?? '').trim();
  if (!crudo)
    throw new Error(
      'Falta MERCADOPAGO_TOKEN_KEY: sin esa clave no se pueden guardar ni leer los tokens de MercadoPago.',
    );
  if (!/^[0-9a-fA-F]{64}$/.test(crudo))
    throw new Error(
      'MERCADOPAGO_TOKEN_KEY tiene que ser de 32 bytes en hexadecimal (64 caracteres). Generala con: openssl rand -hex 32',
    );
  return Buffer.from(crudo, 'hex');
}

/** Si no hay clave configurada el cobro con MercadoPago queda apagado, en vez de fallar al cobrar. */
export function hayClaveDeTokens(): boolean {
  try {
    return clave().length === BYTES_DE_CLAVE;
  } catch {
    return false;
  }
}

export function cifrarToken(texto: string): string {
  // IV nuevo por cifrado: reusarlo con la misma clave rompe GCM por completo.
  const iv = randomBytes(12);
  const cifrador = createCipheriv('aes-256-gcm', clave(), iv);
  const cifrado = Buffer.concat([cifrador.update(texto, 'utf8'), cifrador.final()]);
  // Base64 no usa el punto, así que sirve de separador.
  return [
    FORMATO,
    iv.toString('base64'),
    cifrador.getAuthTag().toString('base64'),
    cifrado.toString('base64'),
  ].join('.');
}

export function descifrarToken(guardado: string): string {
  const [version, iv, tag, cifrado] = (guardado ?? '').split('.');
  if (version !== FORMATO || !iv || !tag || !cifrado)
    throw new Error('El token guardado no tiene el formato esperado.');
  const descifrador = createDecipheriv('aes-256-gcm', clave(), Buffer.from(iv, 'base64'));
  descifrador.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    descifrador.update(Buffer.from(cifrado, 'base64')),
    descifrador.final(),
  ]).toString('utf8');
}
