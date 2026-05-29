const crypto = require("crypto");

// Constant-time string equality. Returns false (without timing leak) on
// length mismatch or non-string input.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// Bearer-token auth — checks against either the primary or the rotating
// secondary token. Constant-time to avoid leaking which characters match
// via response timing. Unlike a JWT, these are static; rotation happens by
// updating ACCESS_TOKEN_SECRET / TEMPO_ACCESS_TOKEN_SECRET in env.
module.exports.auth = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).send("A token is required for authentication");
  }

  const primary = process.env.ACCESS_TOKEN_SECRET;
  const tempo = process.env.TEMPO_ACCESS_TOKEN_SECRET;

  if (
    (primary && safeEqual(token, primary)) ||
    (tempo && safeEqual(token, tempo))
  ) {
    return next();
  }

  return res.status(401).send("Invalid Token");
};

// In-memory IP rate limiter. State is per-process — not multi-instance
// safe, resets on restart. For a single Render dyno this is fine.
//
// The IP map is pruned every windowMs (or 5 min, whichever is shorter) to
// keep memory bounded under a flood of one-shot IPs.
module.exports.rateLimiter = (windowMs = 15 * 60 * 1000, max = 1000) => {
  const requests = new Map();

  const prune = () => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, times] of requests) {
      const fresh = times.filter((t) => t > cutoff);
      if (fresh.length === 0) requests.delete(ip);
      else if (fresh.length !== times.length) requests.set(ip, fresh);
    }
  };
  setInterval(prune, Math.min(windowMs, 5 * 60 * 1000)).unref();

  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const cutoff = now - windowMs;

    const times = (requests.get(ip) || []).filter((t) => t > cutoff);
    if (times.length >= max) {
      return res.status(429).json({
        success: false,
        message: "Too many requests, please try again later",
        error: "RATE_LIMIT_EXCEEDED",
      });
    }

    times.push(now);
    requests.set(ip, times);
    next();
  };
};
