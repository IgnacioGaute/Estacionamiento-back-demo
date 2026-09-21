import { HttpException, HttpStatus } from '@nestjs/common';

// Bounded, per-process limits. Uses the connection IP, never an untrusted forwarded header.
const attempts = new Map<string, { count: number; until: number }>();
export function limitLogin(ip: string, identifier: unknown) {
  const now = Date.now();
  for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
  const keys: [string, number, number][] = [
    [`ip:${ip}`, 100, 60_000],
    [`login:${ip}:${String(identifier ?? '').slice(0, 255).trim().toLowerCase()}`, 15, 5 * 60_000],
  ];
  for (const [key, limit, window] of keys) {
    const bucket = attempts.get(key) ?? { count: 0, until: now + window };
    if (bucket.count >= limit || (!attempts.has(key) && attempts.size >= 10_000)) {
      throw new HttpException('Demasiados intentos. Esperá unos minutos.', HttpStatus.TOO_MANY_REQUESTS);
    }
    bucket.count++;
    attempts.set(key, bucket);
  }
}
