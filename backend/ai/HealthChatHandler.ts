import type { AnyHealthEvent } from "../domain/HealthTimeline";
import type { ClinicalEvent } from "../domain/ClinicalEvent";
import type { InsightEvent } from "../domain/InsightEvent";
import type { LifestyleEvent } from "../domain/LifestyleEvent";
import type { MedicationEvent } from "../domain/MedicationEvent";
import type { SymptomEvent } from "../domain/SymptomEvent";
import type { ConfidenceLevel, HealthEventType, ISODateTimeString } from "../domain/HealthEvent";
import {
  buildHealthChatPrompt,
  callLLMAdapter,
  getDemoFallbackResponse,
  strictParseJsonObject,
} from "./PromptBuilders";

export interface HealthChatResponse {
  readonly reply: string;
  readonly disclaimer: string;
}

function pickEventBaseForAI(event: {
  id: string;
  eventType: HealthEventType;
  timestamp: { absolute: ISODateTimeString; relative?: { reference: string; offset: string } };
  source: string;
  confidence: ConfidenceLevel;
  visibilityScope: string;
  duration?: unknown;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: event.id,
    eventType: event.eventType,
    timestamp: { absolute: event.timestamp.absolute, relative: event.timestamp.relative },
    source: event.source,
    confidence: event.confidence,
    visibilityScope: event.visibilityScope,
  };
  if (event.duration) base.duration = event.duration;
  return base;
}

function sanitizeAnyEvent(event: AnyHealthEvent): Record<string, unknown> {
  switch (event.eventType) {
    case "Medication": {
      const e = event as MedicationEvent;
      return { ...pickEventBaseForAI(e), name: e.name, dosage: e.dosage, intendedSchedule: e.intendedSchedule, adherenceOutcome: e.adherenceOutcome };
    }
    case "Symptom": {
      const e = event as SymptomEvent;
      return { ...pickEventBaseForAI(e), description: e.description, intensity: e.intensity, userReportedContext: e.userReportedContext };
    }
    case "Lifestyle": {
      const e = event as LifestyleEvent;
      return { ...pickEventBaseForAI(e), sleep: e.sleep, stress: e.stress, activity: e.activity, food: e.food };
    }
    case "Clinical": {
      const e = event as ClinicalEvent;
      return { ...pickEventBaseForAI(e), doctorVisit: e.doctorVisit, diagnosisLabel: e.diagnosisLabel };
    }
    case "Insight": {
      const e = event as InsightEvent;
      return { ...pickEventBaseForAI(e), evidenceEventIds: e.evidenceEventIds };
    }
    default: {
      const _exhaustiveCheck: never = event as never;
      throw new Error(`Unhandled event type: ${_exhaustiveCheck}`);
    }
  }
}

// This is NOT a DRAFT AI output — it is conversational.
// No evidence discipline required. No review-first policy.
// Boundary: Allows general health education and preventive guidance.
// Hard limits: No diagnosis, no prescriptions, no dosage, no emergency directives.
export async function handleHealthChat(args: {
  readonly userMessage: string;
  readonly recentEvents: readonly AnyHealthEvent[];
}): Promise<HealthChatResponse> {
  if (!args.userMessage.trim()) throw new Error("userMessage must be a non-empty string.");
  const eventIds = args.recentEvents.map((e) => e.id);

  const sanitized = args.recentEvents.map(sanitizeAnyEvent);
  const { task, prompt } = buildHealthChatPrompt({
    userMessage: args.userMessage,
    recentEvents: sanitized,
  });

  let raw: string;
  try {
    raw = await callLLMAdapter({ task, prompt });
  } catch {
    raw = getDemoFallbackResponse(task, eventIds);
  }

  let parsed: unknown;
  try {
    parsed = strictParseJsonObject(raw);
  } catch {
    parsed = strictParseJsonObject(getDemoFallbackResponse(task, eventIds));
  }

  if (!parsed || typeof parsed !== "object") throw new Error("LLM output must be a JSON object.");

  const obj = parsed as Record<string, unknown>;
  const reply = obj["reply"];
  const disclaimer = obj["disclaimer"];

  if (typeof reply !== "string" || !reply.trim()) throw new Error("LLM output must contain a non-empty reply.");

  const DEFAULT_HEALTH_DISCLAIMER =
    "While this information may help you understand your symptoms, it is not a medical diagnosis. " +
    "For personalized medical advice, please consult a qualified healthcare professional.";

  return {
    reply: reply.trim(),
    disclaimer: typeof disclaimer === "string" && disclaimer.trim()
      ? disclaimer.trim()
      : DEFAULT_HEALTH_DISCLAIMER,
  };
}
