import { isIP } from 'node:net';

/**
 * Normalizes a socket remote IP address, mapping IPv4-mapped IPv6 (`::ffff:x.x.x.x`)
 * to canonical IPv4 and stripping any IPv6 zone suffix.
 */
export const normalizeClientIp = (rawIp: string | undefined): string | null => {
  if (rawIp === undefined) {
    return null;
  }

  let candidate = rawIp.trim();
  if (candidate.length === 0) {
    return null;
  }

  const zoneIndex = candidate.indexOf('%');
  if (zoneIndex !== -1) {
    candidate = candidate.slice(0, zoneIndex);
  }

  const lower = candidate.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const mappedV4 = lower.slice('::ffff:'.length);
    if (isIP(mappedV4) === 4) {
      return mappedV4;
    }
  }

  const ipVersion = isIP(lower);
  if (ipVersion === 0) {
    return null;
  }

  return lower;
};

/**
 * Tracks concurrent active WebSocket connections per normalized client IP address.
 */
export class IpConnectionLimiter {
  readonly #limit: number;
  readonly #counts = new Map<string, number>();

  constructor(limit: number) {
    this.#limit = limit;
  }

  get limit(): number {
    return this.#limit;
  }

  tryAcquire(ip: string): boolean {
    const current = this.#counts.get(ip) ?? 0;
    if (current >= this.#limit) {
      return false;
    }

    this.#counts.set(ip, current + 1);
    return true;
  }

  release(ip: string): void {
    const current = this.#counts.get(ip);
    if (current === undefined) {
      return;
    }

    if (current <= 1) {
      this.#counts.delete(ip);
      return;
    }

    this.#counts.set(ip, current - 1);
  }

  countFor(ip: string): number {
    return this.#counts.get(ip) ?? 0;
  }

  totalTrackedIps(): number {
    return this.#counts.size;
  }

  clear(): void {
    this.#counts.clear();
  }
}

