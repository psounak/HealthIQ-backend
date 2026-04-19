import rateLimit from "express-rate-limit";
import type { Request } from "express";

// HealthIQ v2 — Rate Limiting Middleware
//
// Three tiers:
// 1. General API: 100 req/min per client
// 2. AI endpoints: 30 req/min per client
// 3. Event creation: 50 req/hour per client
//
// Key extraction: uses userId param or IP.

function extractKey(req: Request): string {
  if (req.params.userId) return req.params.userId;
  return req.ip || req.socket.remoteAddress || "unknown";
}

// General API rate limiter: 100 req/min
export const generalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: extractKey,
  message: { error: "Too many requests. Please try again later.", retryAfterMs: 60000 },
});

// AI endpoint rate limiter: 30 req/min
export const aiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: extractKey,
  message: { error: "AI request limit reached. Please wait before trying again.", retryAfterMs: 60000 },
});

// Event creation rate limiter: 50 req/hour
export const eventCreationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: extractKey,
  message: { error: "Event creation limit reached. Maximum 50 events per hour.", retryAfterMs: 3600000 },
});
