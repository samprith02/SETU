// Setu — authentication & rate limiting
//
// Pure middleware + helpers. No business logic.
//
// Two auth modes:
//   - Dev / demo (default when neither SETU_API_KEY nor SETU_AGENT_KEYS is set
//     and SETU_REQUIRE_AUTH !== "1"): requests pass through so local demos work
//     with zero config, while still tagging req.auth.clientId from X-Agent-Id
//     if provided.
//   - Enforced (whenever SETU_API_KEY, SETU_AGENT_KEYS, or SETU_REQUIRE_AUTH=1
//     is set): constant-time Bearer / X-Api-Key verification is mandatory.
//
// Rate limiting uses a lightweight fixed-window store keyed by client identity
// or IP so purchase and checkout routes cannot be hammered unchecked.

import crypto from "node:crypto";

/**
 * Constant-time string comparison via SHA-256 digests so keys of differing
 * lengths never leak length or fail fast.
 */
export function verifySecret(expected, provided) {
  if (typeof expected !== "string" || typeof provided !== "string") return false;
  if (expected.length === 0 || provided.length === 0) return false;
  const a = crypto.createHash("sha256").update(expected, "utf8").digest();
  const b = crypto.createHash("sha256").update(provided, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Extract a token from `Authorization: Bearer <token>` or `X-Api-Key: <token>`.
 */
export function extractToken(req) {
  const authHeader = req.headers?.authorization;
  if (typeof authHeader === "string") {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  const apiKeyHeader = req.headers?.["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.trim().length > 0) {
    return apiKeyHeader.trim();
  }
  return null;
}

/**
 * Parse SETU_AGENT_KEYS from env.
 * Accepts JSON (`{"claude":"key1","cursor":"key2"}`) or comma-separated
 * `agentId:key` pairs (`claude:key1,cursor:key2`).
 * Returns a Map<agentId, secret>.
 */
export function parseAgentKeys(raw = process.env.SETU_AGENT_KEYS) {
  const map = new Map();
  if (!raw || typeof raw !== "string" || raw.trim().length === 0) return map;

  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    for (const [agentId, secret] of Object.entries(parsed)) {
      if (agentId && typeof secret === "string" && secret.length > 0) {
        map.set(agentId, secret);
      }
    }
    return map;
  }

  for (const part of trimmed.split(",")) {
    const idx = part.indexOf(":");
    if (idx <= 0) continue;
    const agentId = part.slice(0, idx).trim();
    const secret = part.slice(idx + 1).trim();
    if (agentId && secret) {
      map.set(agentId, secret);
    }
  }
  return map;
}

/**
 * Middleware protecting merchant-side routes (/audit, /checkout).
 * Requires SETU_API_KEY when SETU_API_KEY is set or SETU_REQUIRE_AUTH=1.
 */
export function authenticateMerchant(req, res, next) {
  const apiKey = process.env.SETU_API_KEY || "";
  const strict = process.env.SETU_REQUIRE_AUTH === "1";

  if (!apiKey && !strict) {
    req.auth = { token: "", clientId: "dev", scopes: ["merchant", "dev"] };
    return next();
  }

  if (!apiKey) {
    return res.status(503).json({
      error: "auth_not_configured",
      detail: "SETU_REQUIRE_AUTH=1 is set but SETU_API_KEY is missing.",
    });
  }

  const token = extractToken(req);
  if (!token || !verifySecret(apiKey, token)) {
    return res.status(401).json({
      error: "unauthorized",
      detail: "Valid merchant API key required via Authorization: Bearer or X-Api-Key.",
    });
  }

  req.auth = { token, clientId: "merchant", scopes: ["merchant"] };
  next();
}

/**
 * Middleware protecting the /mcp endpoint.
 * Accepts either a per-agent secret from SETU_AGENT_KEYS or the merchant
 * SETU_API_KEY, and populates req.auth.clientId so tool calls record which
 * agent acted.
 */
export function authenticateAgent(req, res, next) {
  const apiKey = process.env.SETU_API_KEY || "";
  let agentKeys;
  try {
    agentKeys = parseAgentKeys();
  } catch (err) {
    return res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: `Invalid SETU_AGENT_KEYS configuration: ${err.message}` },
      id: null,
    });
  }

  const strict = process.env.SETU_REQUIRE_AUTH === "1";
  const enforced = strict || apiKey.length > 0 || agentKeys.size > 0;
  const headerAgentId =
    typeof req.headers?.["x-agent-id"] === "string" && req.headers["x-agent-id"].trim()
      ? req.headers["x-agent-id"].trim()
      : null;

  if (!enforced) {
    req.auth = {
      token: "",
      clientId: headerAgentId || "local-agent",
      scopes: ["mcp", "dev"],
    };
    return next();
  }

  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: agent or merchant token required" },
      id: null,
    });
  }

  for (const [agentId, secret] of agentKeys.entries()) {
    if (verifySecret(secret, token)) {
      req.auth = { token, clientId: agentId, scopes: ["mcp", "agent"] };
      return next();
    }
  }

  if (apiKey && verifySecret(apiKey, token)) {
    req.auth = {
      token,
      clientId: headerAgentId || "merchant-key",
      scopes: ["mcp", "merchant"],
    };
    return next();
  }

  return res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized: invalid token" },
    id: null,
  });
}

/**
 * Simple fixed-window in-memory rate limiter for purchase and MCP routes.
 */
export function createRateLimiter({
  windowMs = 60_000,
  max = 60,
  isJsonRpc = false,
} = {}) {
  const buckets = new Map();

  return (req, res, next) => {
    const now = Date.now();

    // Opportunistically prune expired buckets when map grows.
    if (buckets.size > 1000) {
      for (const [k, b] of buckets.entries()) {
        if (b.resetAt <= now) buckets.delete(k);
      }
    }

    const identity =
      req.auth?.clientId && req.auth.clientId !== "dev"
        ? `client:${req.auth.clientId}`
        : `ip:${req.ip || req.socket?.remoteAddress || "unknown"}`;

    let bucket = buckets.get(identity);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(identity, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, max - bucket.count);
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      res.setHeader("Retry-After", String(retryAfterSec));
      if (isJsonRpc) {
        return res.status(429).json({
          jsonrpc: "2.0",
          error: {
            code: -32029,
            message: `Rate limit exceeded. Retry after ${retryAfterSec}s.`,
          },
          id: null,
        });
      }
      return res.status(429).json({
        error: "rate_limit_exceeded",
        retry_after_seconds: retryAfterSec,
      });
    }

    next();
  };
}

