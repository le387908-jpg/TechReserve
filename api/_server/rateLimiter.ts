/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

interface RateLimitBucket {
  timestamps: number[];
  expiresAt: number;
}

const buckets = new Map<string, RateLimitBucket>();
const MAX_BUCKETS = 5000;

function pruneExpiredBuckets(now: number): void {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.expiresAt <= now) {
      buckets.delete(key);
    }
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Extrai o IP real do cliente em ambientes Express, Cloud Run e Vercel Serverless.
 */
export function extractClientIp(req: {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim().slice(0, 64);
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return String(forwarded[0]).split(',')[0].trim().slice(0, 64);
  }
  const realIp = req?.headers?.['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim().slice(0, 64);
  }
  return String(req?.ip || req?.socket?.remoteAddress || 'unknown').slice(0, 64);
}

/**
 * Aplica controle de taxa (sliding window) em memória por escopo + IP/UID.
 * Em Vercel Serverless protege instâncias quentes contra rajadas e abuso;
 * em Express/Cloud Run protege globalmente o processo Node.js.
 */
export function checkRateLimit(params: {
  scope: string;
  identifier: string;
  maxRequests: number;
  windowMs: number;
}): RateLimitResult {
  const { scope, identifier, maxRequests, windowMs } = params;
  const now = Date.now();
  pruneExpiredBuckets(now);

  const key = `${scope}:${identifier}`;
  const cutoff = now - windowMs;
  const existing = buckets.get(key);
  const validTimestamps = existing
    ? existing.timestamps.filter((ts) => ts > cutoff)
    : [];

  if (validTimestamps.length >= maxRequests) {
    const oldest = validTimestamps[0] || now;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    buckets.set(key, {
      timestamps: validTimestamps,
      expiresAt: now + windowMs,
    });
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds,
    };
  }

  validTimestamps.push(now);
  buckets.set(key, {
    timestamps: validTimestamps,
    expiresAt: now + windowMs,
  });

  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - validTimestamps.length),
    retryAfterSeconds: 0,
  };
}
