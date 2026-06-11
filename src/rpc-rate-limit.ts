import type { Request, Response, NextFunction } from 'express';

/** Rate limit windows */
export const GET_RATE_LIMIT = 600;   // requests per minute
export const POST_RATE_LIMIT = 100;  // requests per minute
export const RATE_WINDOW_MS = 60_000;

type RateLimitData = {
  timestamps: number[];
};

type RateLimiter = {
  (bucket: string, limit: number): (req: Request, res: Response, next: NextFunction) => void;
  close: () => void;
};

/** Simple in-memory per-IP rate limiter (sliding window) */
export function createRateLimiter(windowMs = RATE_WINDOW_MS): RateLimiter {
  const hits = new Map<string, RateLimitData>();

  // Cleanup stale entries every 5 minutes
  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, data] of hits) {
      data.timestamps = data.timestamps.filter(t => t > cutoff);
      if (data.timestamps.length === 0) hits.delete(ip);
    }
  }, 5 * 60_000).unref();

  const limiter = (bucket: string, limit: number) => (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const key = `${bucket}:${ip}`;
    const now = Date.now();
    const cutoff = now - windowMs;

    let data = hits.get(key);
    if (!data) {
      data = { timestamps: [] };
      hits.set(key, data);
    }

    // Remove old timestamps
    data.timestamps = data.timestamps.filter(t => t > cutoff);

    if (data.timestamps.length >= limit) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    data.timestamps.push(now);
    next();
  };
  limiter.close = () => clearInterval(cleanupTimer);
  return limiter;
}
