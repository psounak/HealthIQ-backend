import type { AnyHealthEvent, TimeWindow } from "../domain/HealthTimeline";
import type { ClinicalEvent } from "../domain/ClinicalEvent";
import type { InsightEvent } from "../domain/InsightEvent";
import type { LifestyleEvent } from "../domain/LifestyleEvent";
import type { MedicationEvent } from "../domain/MedicationEvent";
import type { SymptomEvent } from "../domain/SymptomEvent";
import type { ConfidenceLevel, HealthEventType, ISODateTimeString, NonEmptyArray } from "../domain/HealthEvent";
import {
  asConfidenceLevel,
  asNonEmptyStringArray,
  asStringArray,
  assertEvidenceSubset,
  buildDoctorVisitSummaryPrompt,
  callLLMAdapter,
  getDemoFallbackResponse,
  isDemoFallback,
  strictParseJsonObject,
  type DraftAIOutput,
} from "./PromptBuilders";

export type DoctorVisitSummaryDraft = DraftAIOutput<
  "Doctor-Visit Summary",
  {
    readonly summary: string;
    readonly includedEventIds: NonEmptyArray<string>;
  }
>;

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
    timestamp: {
      absolute: event.timestamp.absolute,
      relative: event.timestamp.relative,
    },
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
      return {
        ...pickEventBaseForAI(e),
        name: e.name,
        dosage: e.dosage,
        intendedSchedule: e.intendedSchedule,
        adherenceOutcome: e.adherenceOutcome,
      };
    }
    case "Symptom": {
      const e = event as SymptomEvent;
      return {
        ...pickEventBaseForAI(e),
        description: e.description,
        intensity: e.intensity,
        userReportedContext: e.userReportedContext,
      };
    }
    case "Lifestyle": {
      const e = event as LifestyleEvent;
      return {
        ...pickEventBaseForAI(e),
        sleep: e.sleep,
        stress: e.stress,
        activity: e.activity,
        food: e.food,
      };
    }
    case "Clinical": {
      const e = event as ClinicalEvent;
      return {
        ...pickEventBaseForAI(e),
        doctorVisit: e.doctorVisit,
        diagnosisLabel: e.diagnosisLabel,
      };
    }
    case "Insight": {
      const e = event as InsightEvent;
      return {
        ...pickEventBaseForAI(e),
        evidenceEventIds: e.evidenceEventIds,
      };
    }
    default: {
      const _exhaustiveCheck: never = event as never;
      throw new Error(`Unhandled event type: ${_exhaustiveCheck}`);
    }
  }
}

// REVIEW-FIRST POLICY:
// - Output MUST be reviewed before saving.
// - Output is aggregation-only and MUST NOT introduce new interpretations.
// - Output MUST NOT include advice, urgency, or treatment guidance.
export async function summarizeDoctorVisit(args: {
  readonly window: TimeWindow;
  readonly relevantEvents: readonly AnyHealthEvent[];
}): Promise<DoctorVisitSummaryDraft> {
  if (!args.relevantEvents.length) throw new Error("Doctor-visit summary requires non-empty relevantEvents.");

  const allowedIds = new Set<string>(args.relevantEvents.map((e) => e.id));
  const sanitizedEvents = args.relevantEvents.map(sanitizeAnyEvent);

  const { task, prompt } = buildDoctorVisitSummaryPrompt({
    window: args.window,
    relevantEvents: sanitizedEvents,
  });

  let raw: string;
  try {
    raw = await callLLMAdapter({ task, prompt });
  } catch {
    // Demo fallback: return deterministic, clearly-marked response when API is down.
    raw = getDemoFallbackResponse(task, [...allowedIds]);
  }

  const parsed = strictParseJsonObject(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("LLM output must be a JSON object.");

  const obj = parsed as Record<string, unknown>;

  const summary = obj["summary"];
  if (typeof summary !== "string" || !summary.trim()) throw new Error("summary must be a non-empty string.");

  const includedEventIds = asNonEmptyStringArray(obj["includedEventIds"], "includedEventIds") as NonEmptyArray<string>;
  assertEvidenceSubset({ evidenceEventIds: includedEventIds, allowedEventIds: allowedIds });

  const confidence = asConfidenceLevel(obj["confidence"]);
  const uncertaintyNotes = asStringArray(obj["uncertaintyNotes"], "uncertaintyNotes");

  return {
    DRAFT_AI_OUTPUT: true,
    taskName: "Doctor-Visit Summary",
    result: {
      summary: summary.trim(),
      includedEventIds,
    },
    confidence,
    evidenceEventIds: includedEventIds,
    uncertaintyNotes,
  };
}
