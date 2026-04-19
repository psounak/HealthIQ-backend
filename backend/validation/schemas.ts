import { z } from "zod";

// HealthIQ v2 — Input Validation Schemas (Zod)
//
// Validates all incoming API payloads before they reach domain logic.
// These schemas mirror the domain types but enforce runtime constraints
// that TypeScript types alone cannot guarantee.

// --- Shared ---

const ISODateTimeSchema = z.string().refine(
  (val: string) => !isNaN(Date.parse(val)),
  { message: "Must be a valid ISO 8601 datetime string" },
);

const ConfidenceLevelSchema = z.enum(["low", "medium", "high"]);

const EventSourceSchema = z.enum(["user", "prescription", "device", "doctor"]);

const VisibilityScopeSchema = z.enum(["user-only", "doctor-shareable"]).default("user-only");

const HealthEventTypeSchema = z.enum(["Medication", "Symptom", "Lifestyle", "Clinical", "Insight"]);

const RelativeTimestampSchema = z.object({
  reference: z.string().min(1),
  offset: z.string().min(1),
}).optional();

const TimestampSchema = z.object({
  absolute: ISODateTimeSchema,
  relative: RelativeTimestampSchema,
});

const EventDurationSchema = z.union([
  z.object({
    kind: z.literal("interval"),
    startAbsolute: ISODateTimeSchema,
    endAbsolute: ISODateTimeSchema,
  }),
  z.object({
    kind: z.literal("reported"),
    value: z.string().min(1),
  }),
]).optional();

const HealthEventLinksSchema = z.object({
  evidence: z.array(z.string()).optional(),
  causalContext: z.array(z.string()).optional(),
  sameEpisode: z.array(z.string()).optional(),
  supersedes: z.array(z.string()).optional(),
  clarifies: z.array(z.string()).optional(),
}).optional();

// --- Event base ---
const HealthEventBaseSchema = z.object({
  id: z.string().min(1, "Event ID is required"),
  eventType: HealthEventTypeSchema,
  timestamp: TimestampSchema,
  source: EventSourceSchema,
  confidence: ConfidenceLevelSchema.default("medium"),
  visibilityScope: VisibilityScopeSchema,
  duration: EventDurationSchema,
  tags: z.array(z.string()).optional(),
  links: HealthEventLinksSchema,
  notes: z.string().max(2000, "Notes must be 2000 characters or less").optional(),
  metadata: z.record(z.unknown()).optional(),
});

// --- Type-specific events ---

export const SymptomEventSchema = HealthEventBaseSchema.extend({
  eventType: z.literal("Symptom"),
  description: z.string().min(1).max(2000),
  intensity: z.string().max(100).optional(),
  userReportedContext: z.string().max(2000).optional(),
});

export const MedicationEventSchema = HealthEventBaseSchema.extend({
  eventType: z.literal("Medication"),
  name: z.string().min(1).max(500),
  dosage: z.string().min(1).max(500),
  intendedSchedule: z.string().min(1).max(500),
  adherenceOutcome: z.enum(["taken", "missed", "delayed"]),
});

export const LifestyleEventSchema = HealthEventBaseSchema.extend({
  eventType: z.literal("Lifestyle"),
  sleep: z.string().max(500).optional(),
  stress: z.string().max(500).optional(),
  activity: z.string().max(500).optional(),
  food: z.string().max(500).optional(),
});

export const ClinicalEventSchema = HealthEventBaseSchema.extend({
  eventType: z.literal("Clinical"),
  doctorVisit: z.string().min(1).max(2000),
  diagnosisLabel: z.string().max(500).optional(),
});

export const InsightEventSchema = HealthEventBaseSchema.extend({
  eventType: z.literal("Insight"),
  evidenceEventIds: z.array(z.string().min(1)).min(1),
  reviewStatus: z.enum(["draft", "reviewed"]),
});

// Union discriminated by eventType
export const AnyHealthEventSchema = z.discriminatedUnion("eventType", [
  SymptomEventSchema,
  MedicationEventSchema,
  LifestyleEventSchema,
  ClinicalEventSchema,
  InsightEventSchema,
]);

// --- API request schemas ---

export const AppendEventsRequestSchema = z.object({
  events: z.array(AnyHealthEventSchema).min(1).optional(),
  event: AnyHealthEventSchema.optional(),
}).refine(
  (data: { events?: unknown; event?: unknown }) => data.events || data.event,
  { message: "Request body must contain 'events' array or 'event' object." },
);

export const TimeWindowSchema = z.object({
  startAbsolute: ISODateTimeSchema,
  endAbsolute: ISODateTimeSchema,
}).refine(
  (data: { startAbsolute: string; endAbsolute: string }) => new Date(data.startAbsolute) <= new Date(data.endAbsolute),
  { message: "startAbsolute must be before or equal to endAbsolute" },
);

export const SymptomInterpretationRequestSchema = z.object({
  userId: z.string().min(8).optional(),
  symptoms: z.array(SymptomEventSchema).min(1).optional(),
  recentMedications: z.array(MedicationEventSchema).optional(),
  recentLifestyle: z.array(LifestyleEventSchema).optional(),
}).refine(
  (data: { userId?: string; symptoms?: unknown[] }) => data.userId || data.symptoms,
  { message: "Provide 'userId' or non-empty 'symptoms' array." },
);

export const HealthPatternsRequestSchema = z.object({
  userId: z.string().min(8),
  window: TimeWindowSchema,
});

export const SpecializationsRequestSchema = z.object({
  symptomLabels: z.array(z.object({
    label: z.string().min(1),
    confidence: ConfidenceLevelSchema,
    evidenceEventIds: z.array(z.string().min(1)).min(1),
  })).min(1),
  insights: z.array(z.unknown()).optional(),
});

export const DoctorVisitSummaryRequestSchema = z.object({
  userId: z.string().min(8),
  window: TimeWindowSchema,
});

export const ChatRequestSchema = z.object({
  userId: z.string().min(8),
  message: z.string().min(1).max(5000, "Message must be 5000 characters or less"),
});

export const TokenRequestSchema = z.object({
  deviceId: z.string().min(8).max(128),
});

export const RefreshTokenRequestSchema = z.object({
  refreshToken: z.string().min(1),
});

// --- Abuse detection ---

export function detectPromptInjection(text: string): boolean {
  // Basic patterns that suggest prompt injection attempts
  const patterns = [
    /ignore\s+(previous|above|all)\s+instructions/i,
    /you\s+are\s+now\s+/i,
    /forget\s+(everything|all|your)\s+/i,
    /system\s*:\s*/i,
    /\bact\s+as\b/i,
    /\bpretend\s+to\s+be\b/i,
    /\boverride\b.*\binstructions?\b/i,
    /\bignore\b.*\bsafety\b/i,
    /\bjailbreak\b/i,
    /\bDAN\b/,
    /do\s+anything\s+now/i,
  ];

  return patterns.some((p) => p.test(text));
}

export function validateTimestampNotFuture(timestamp: string, maxFutureHours: number = 48): boolean {
  const eventTime = new Date(timestamp).getTime();
  const maxAllowed = Date.now() + maxFutureHours * 60 * 60 * 1000;
  return eventTime <= maxAllowed;
}
