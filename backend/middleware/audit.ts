import type { Request, Response, NextFunction } from "express";

// HealthIQ v2 — In-Memory Audit Logger
//
// Lightweight request auditing without database persistence.
// Stores last N entries in a circular buffer for diagnostics.
// Zero external dependencies — no database, no file I/O.

interface AuditEntry {
  timestamp: string;
  method: string;
  path: string;
  ip: string;
  userId?: string;
  statusCode: number;
  durationMs: number;
}

const MAX_ENTRIES = 500;
const entries: AuditEntry[] = [];

export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on("finish", () => {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      ip: req.ip || req.socket.remoteAddress || "unknown",
      userId: req.params?.userId || undefined,
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
    };

    entries.push(entry);
    if (entries.length > MAX_ENTRIES) {
      entries.shift();
    }
  });

  next();
}

/** Retrieve recent audit entries for diagnostics (GET /api/audit) */
export function getRecentAuditEntries(limit = 50): AuditEntry[] {
  return entries.slice(-limit).reverse();
}
