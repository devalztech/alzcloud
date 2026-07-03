/**
 * Minimal in-memory rate limiter — no external dependency required.
 *
 * NOTE: state lives in a plain Map, so this only works correctly on a
 * single instance. AlzCloud currently runs as one Render web service, so
 * that's fine. If it's ever scaled to multiple instances, swap the Map for
 * a shared store (e.g. Redis) or the counts will be per-process.
 */

const buckets = new Map();

// Sweep expired entries periodically so the Map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

/**
 * @param {number} windowMs - length of the rate limit window in ms
 * @param {number} max - max requests allowed per window per key
 * @param {(req) => string} [keyFn] - defaults to req.ip
 * @param {(req, res, retryAfterSeconds) => void} [onLimit] - custom 429 handler
 */
function rateLimit({ windowMs, max, keyFn, onLimit }) {
  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.ip;
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count++;

    if (bucket.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', retryAfterSec);
      if (onLimit) return onLimit(req, res, retryAfterSec);
      return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    }

    next();
  };
}

module.exports = { rateLimit };
