import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { existsSync } from "fs";
import { resolve as pathResolve } from "path";

// Load .env before any module that reads process.env.
// Resolve from deterministic locations so startup cwd does not matter.
const envPathCandidates = [
  pathResolve(__dirname, "..", ".env"),
  pathResolve(__dirname, "..", "..", ".env"),
  pathResolve(process.cwd(), ".env"),
];

const resolvedEnvPath = envPathCandidates.find((p) => existsSync(p));
if (resolvedEnvPath) {
  dotenv.config({ path: resolvedEnvPath });
} else {
  dotenv.config();
}

import { getTimelineRepository } from "./repository/RepositoryFactory";
import type { UserId } from "./repository/TimelineRepository";
import type { AnyHealthEvent, TimeWindow } from "./domain/HealthTimeline";
import { HealthEventType } from "./domain/HealthEvent";
import { EventSource } from "./domain/EventSource";
import { VisibilityScope } from "./domain/VisibilityScope";
import type { SymptomEvent } from "./domain/SymptomEvent";
import type { MedicationEvent } from "./domain/MedicationEvent";
import type { LifestyleEvent } from "./domain/LifestyleEvent";
import type { ClinicalEvent } from "./domain/ClinicalEvent";

import { interpretSymptoms } from "./ai/SymptomInterpreter";
import { analyzeHealthPatterns } from "./ai/HealthPatternAnalyzer";
import { suggestMedicalSpecializations } from "./ai/SpecializationSuggester";
import { summarizeDoctorVisit } from "./ai/DoctorVisitSummarizer";
import { handleHealthChat } from "./ai/HealthChatHandler";

// v2 middleware (no auth — LocalStorage-first, stateless server)
import { generalRateLimiter, aiRateLimiter, eventCreationRateLimiter } from "./middleware/rateLimiter";
import { auditMiddleware, getRecentAuditEntries } from "./middleware/audit";

// v2 analytics (stateless — pure functions, no DB persistence)
import { computeHSI } from "./analytics/HSIScorer";
import type { HSIScore } from "./analytics/HSIScorer";
import { buildGraphFromEvents } from "./analytics/HealthGraphBuilder";
import { evaluateAlerts, computeRiskLevel, generateBehavioralSuggestions } from "./analytics/AlertEngine";

// v2 validation (Zod schemas + abuse detection)
import {
  AppendEventsRequestSchema,
  ChatRequestSchema,
  HealthPatternsRequestSchema,
  SpecializationsRequestSchema,
  DoctorVisitSummaryRequestSchema,
  SymptomInterpretationRequestSchema,
  AnyHealthEventSchema,
  detectPromptInjection,
  validateTimestampNotFuture,
} from "./validation/schemas";
import { ZodError } from "zod";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

// ---- CORS ----
const DEFAULT_ORIGINS = [
  "https://healthiq.sentiqlabs.com",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://localhost:3001",
];

const ALLOWED_ORIGINS: string[] = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
  : DEFAULT_ORIGINS;

console.log("[HealthIQ v2] CORS allowed origins:", ALLOWED_ORIGINS);

app.use(cors({
  origin(requestOrigin: string | undefined, callback: (err: Error | null, allow?: boolean | string) => void) {
    // Allow server-to-server / curl / health-pings (no Origin header)
    if (!requestOrigin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(requestOrigin)) {
      return callback(null, requestOrigin);
    }
    console.warn(`[CORS] Blocked request from origin: ${requestOrigin}`);
    callback(new Error(`Origin ${requestOrigin} not allowed by CORS`));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: false,
}));

// Explicit preflight handling for all routes
app.options("*", cors());

app.use(express.json({ limit: "1mb" }));

// ---- Security headers (helmet) ----
app.use(helmet({
  contentSecurityPolicy: false,  // CSP managed by frontend host
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));

// ---- Privacy headers (prevent response caching of health data) ----
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// ---- v2 middleware stack (no auth — LocalStorage-first) ----
app.use(generalRateLimiter);
app.use(auditMiddleware);

// ---- Repository singleton ----
const repo = getTimelineRepository();

// ---- UserId validation helper (Privacy-critical) ----
function validateUserId(userId: string | undefined): UserId | null {
  if (!userId || typeof userId !== "string") return null;
  const trimmed = userId.trim();
  // Reject empty, 'demo-user', 'undefined', 'null', or suspiciously short IDs
  if (!trimmed || trimmed.length < 8 || trimmed === "demo-user" || trimmed === "undefined" || trimmed === "null") {
    return null;
  }
  return trimmed;
}

// ---- Async error wrapper ----
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

// ---- Zod error formatter ----
function formatZodError(err: ZodError): string {
  return err.errors.map(e => `${e.path.join(".")}: ${e.message}`).join("; ");
}

// ===============================
// GET /api/health
// ===============================
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    version: "2.0.0",
    architecture: "stateless-compute",
    storage: "client-localstorage",
    timestamp: new Date().toISOString(),
    features: ["hsi", "health-graph", "alerts", "risk-stratification"],
  });
});

// ===============================
// GET /api/timeline/:userId
// ===============================
app.get("/api/timeline/:userId", asyncHandler(async (req, res) => {
  const userId = validateUserId(req.params.userId);
  if (!userId) {
    res.status(400).json({ error: "Valid userId required. 'demo-user' is no longer accepted." });
    return;
  }
  const snapshot = await repo.getTimeline(userId);
  res.json(snapshot);
}));

// ===============================
// POST /api/timeline/:userId/events
// ===============================
app.post("/api/timeline/:userId/events", eventCreationRateLimiter, asyncHandler(async (req, res) => {
  const userId = validateUserId(req.params.userId);
  if (!userId) {
    res.status(400).json({ error: "Valid userId required. 'demo-user' is no longer accepted." });
    return;
  }

  // Zod validation
  const parsed = AppendEventsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: formatZodError(parsed.error) });
    return;
  }

  const events: AnyHealthEvent[] = parsed.data.events
    ? (parsed.data.events as AnyHealthEvent[])
    : [parsed.data.event as AnyHealthEvent];

  // Reject far-future timestamps
  for (const e of events) {
    if (!validateTimestampNotFuture(e.timestamp.absolute)) {
      res.status(400).json({ error: `Event ${e.id} has a timestamp too far in the future.` });
      return;
    }
  }

  await repo.appendEvents(userId, events);
  res.status(201).json({ appended: events.length });
}));

// =========================================================================
// POST /api/analytics/compute — Stateless v2 analytics
//
// The client sends events from LocalStorage; the server computes
// HSI, graph, alerts, risk, and suggestions, then returns them.
// No server-side persistence — pure compute service.
// =========================================================================
app.post("/api/analytics/compute", asyncHandler(async (req, res) => {
  const { events, previousHSI } = req.body;

  if (!Array.isArray(events) || events.length === 0) {
    res.status(400).json({ error: "Provide a non-empty 'events' array from LocalStorage." });
    return;
  }

  // Validate each event with Zod (lightweight — skip on very large batches for perf)
  if (events.length <= 500) {
    for (let i = 0; i < events.length; i++) {
      const result = AnyHealthEventSchema.safeParse(events[i]);
      if (!result.success) {
        res.status(400).json({ error: `Event[${i}]: ${formatZodError(result.error)}` });
        return;
      }
    }
  }

  // 1. Compute Health Stability Index
  const hsi: HSIScore = computeHSI(events as AnyHealthEvent[]);

  // 2. Build health concept graph
  const topN = Math.min(parseInt(req.query.topN as string) || 15, 50);
  const graphSummary = buildGraphFromEvents(events as AnyHealthEvent[], topN);

  // 3. Evaluate alert rules
  const alerts = evaluateAlerts({
    currentHSI: hsi,
    previousHSI: previousHSI || null,
    events: events as AnyHealthEvent[],
    graphSummary,
  });

  // 4. Risk level
  const risk = computeRiskLevel(hsi, alerts);

  // 5. Behavioral suggestions
  const suggestions = generateBehavioralSuggestions(hsi, alerts, graphSummary);

  res.json({
    hsi: {
      score: Math.round(hsi.score * 10) / 10,
      dataConfidence: hsi.dataConfidence,
      symptomRegularity: Math.round(hsi.symptomRegularity * 10) / 10,
      behavioralConsistency: Math.round(hsi.behavioralConsistency * 10) / 10,
      trajectoryDirection: Math.round(hsi.trajectoryDirection * 10) / 10,
      computedAt: hsi.computedAt,
    },
    graph: {
      topConcepts: graphSummary.topConcepts.slice(0, 10),
      strongestEdges: graphSummary.strongestEdges.slice(0, 10),
      nodeCount: graphSummary.nodeCount,
      edgeCount: graphSummary.edgeCount,
    },
    alerts,
    risk,
    suggestions,
    eventCount: events.length,
  });
}));

// ===============================
// GET /api/audit — recent request log (diagnostics)
// Restricted: only available in development or with admin key
// ===============================
app.get("/api/audit", (req, res) => {
  const adminKey = process.env.AUDIT_ADMIN_KEY;
  const isDev = process.env.NODE_ENV !== "production";
  const providedKey = req.query.key as string;

  if (!isDev && (!adminKey || providedKey !== adminKey)) {
    res.status(403).json({ error: "Audit log access restricted in production." });
    return;
  }

  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  res.json(getRecentAuditEntries(limit));
});

// ===============================
// POST /api/ai/interpret-symptoms
// ===============================
app.post("/api/ai/interpret-symptoms", aiRateLimiter, asyncHandler(async (req, res) => {
  const parsed = SymptomInterpretationRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: formatZodError(parsed.error) });
    return;
  }

  const body = parsed.data;
  let symptoms: SymptomEvent[];
  let recentMedications: MedicationEvent[] | undefined;
  let recentLifestyle: LifestyleEvent[] | undefined;

  if (body.userId) {
    const validatedUid = validateUserId(body.userId);
    if (!validatedUid) {
      res.status(400).json({ error: "Valid userId required. 'demo-user' is no longer accepted." });
      return;
    }
    const allSymptoms = await repo.getEventsByType(validatedUid, HealthEventType.Symptom);
    symptoms = allSymptoms as SymptomEvent[];
    if (symptoms.length === 0) {
      res.status(400).json({ error: "No symptom events found for this user." });
      return;
    }
    const allMeds = await repo.getEventsByType(validatedUid, HealthEventType.Medication);
    recentMedications = allMeds as MedicationEvent[];
    const allLifestyle = await repo.getEventsByType(validatedUid, HealthEventType.Lifestyle);
    recentLifestyle = allLifestyle as LifestyleEvent[];
  } else {
    symptoms = body.symptoms as SymptomEvent[];
    recentMedications = body.recentMedications as MedicationEvent[] | undefined;
    recentLifestyle = body.recentLifestyle as LifestyleEvent[] | undefined;
  }

  const draft = await interpretSymptoms({ symptoms, recentMedications, recentLifestyle });
  res.json(draft);
}));

// ===============================
// POST /api/ai/health-patterns
// ===============================
app.post("/api/ai/health-patterns", aiRateLimiter, asyncHandler(async (req, res) => {
  const parsed = HealthPatternsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: formatZodError(parsed.error) });
    return;
  }

  const userId = validateUserId(parsed.data.userId);
  const tw = parsed.data.window;
  if (!userId) {
    res.status(400).json({ error: "Valid userId required." });
    return;
  }

  const events = await repo.getEventsByWindow(userId, tw as TimeWindow);
  if (events.length === 0) {
    res.status(400).json({ error: "No events found in the specified time window." });
    return;
  }

  const draft = await analyzeHealthPatterns({ timelineSlice: events as AnyHealthEvent[], window: tw });
  res.json(draft);
}));

// ===============================
// POST /api/ai/specializations
// ===============================
app.post("/api/ai/specializations", aiRateLimiter, asyncHandler(async (req, res) => {
  const parsed = SpecializationsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: formatZodError(parsed.error) });
    return;
  }

  const draft = await suggestMedicalSpecializations(parsed.data as any);
  res.json(draft);
}));

// ===============================
// POST /api/ai/doctor-visit-summary
// ===============================
app.post("/api/ai/doctor-visit-summary", aiRateLimiter, asyncHandler(async (req, res) => {
  const parsed = DoctorVisitSummaryRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: formatZodError(parsed.error) });
    return;
  }

  const userId = validateUserId(parsed.data.userId);
  const tw = parsed.data.window;
  if (!userId) {
    res.status(400).json({ error: "Valid userId required." });
    return;
  }

  const events = await repo.getEventsByWindow(userId, tw as TimeWindow);
  if (events.length === 0) {
    res.status(400).json({ error: "No events found in the specified time window." });
    return;
  }

  const draft = await summarizeDoctorVisit({ window: tw, relevantEvents: events as AnyHealthEvent[] });
  res.json(draft);
}));

// ===============================
// POST /api/ai/chat
// ===============================
app.post("/api/ai/chat", aiRateLimiter, asyncHandler(async (req, res) => {
  const parsed = ChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: formatZodError(parsed.error) });
    return;
  }

  const { userId: rawUserId, message } = parsed.data;

  // Prompt injection detection
  if (detectPromptInjection(message)) {
    res.status(400).json({ error: "Message contains disallowed patterns." });
    return;
  }

  const uid = validateUserId(rawUserId);
  if (!uid) {
    res.status(400).json({ error: "Valid userId required. Each device must provide its unique identifier." });
    return;
  }
  const snapshot = await repo.getTimeline(uid);
  const recentEvents = snapshot.events.slice(-20);

  const chatResponse = await handleHealthChat({
    userMessage: message.trim(),
    recentEvents,
  });

  res.json(chatResponse);
}));

// ---- Global error handler (sanitized — never leak internals to clients) ----
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[HealthIQ Server Error]", err.message);
  // Never return raw error messages to clients — they may contain file paths or stack details
  const isValidation = err.message?.includes("Append rejected") || err.message?.includes("evidenceEventId");
  const safeMessage = isValidation ? err.message : "Internal server error.";
  res.status(isValidation ? 400 : 500).json({ error: safeMessage });
});

// ---- Graceful shutdown ----
process.on("SIGTERM", () => { console.log("[HealthIQ] SIGTERM — shutting down"); process.exit(0); });
process.on("SIGINT", () => { console.log("[HealthIQ] SIGINT — shutting down"); process.exit(0); });

// ---- Start server ----
// No demo seed — timeline starts empty. Users add events via the frontend.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[HealthIQ v2] Server running on port ${PORT}`);
  console.log(`[HealthIQ v2] API health check: http://0.0.0.0:${PORT}/api/health`);
  console.log(`[HealthIQ v2] Architecture: Stateless compute — user data in client LocalStorage`);
  console.log(`[HealthIQ v2] Environment: ${process.env.NODE_ENV || "development"}`);
});
