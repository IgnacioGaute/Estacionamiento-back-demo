import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  port: parseInt(process.env.PORT as string, 10) || 3030,
  // Coma-separada — permite habilitar varios orígenes a la vez (ej. localhost para desarrollo
  // en la compu + la IP de LAN para probar desde el celular) sin tener un solo string exacto.
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
  nodenv: process.env.NODE_ENV,
}));
