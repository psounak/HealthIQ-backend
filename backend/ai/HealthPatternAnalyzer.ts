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
  buildHealthPatternInsightPrompt,
  callLLMAdapter,
  getDemoFallbackResponse,
  isDemoFallback,
  strictParseJsonObject,
  type DraftAIOutput,
} from "./PromptBuilders";

export type HealthPatternInsightDraft = DraftAIOutput<
  "Health Pattern Insight",
  {
    readonly insightDraft: {
      readonly title: string;
      readonly summary: string;
      readonly hypotheses: readonly string[];
    };
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
  // Mirrors PromptBuilders: strip notes/metadata/tags/links.
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
      // Exhaustiveness guard
      const _exhaustiveCheck: never = event as never;
      throw new Error(`Unhandled event type: ${_exhaustiveCheck}`);
    }
  }
}

// REVIEW-FIRST POLICY:
// - This output MUST be reviewed before saving.
// - This output MUST NOT be auto-applied to the timeline.
// - This output can be rejected or contested.
export async function analyzeHealthPatterns(args: {
  readonly timelineSlice: readonly AnyHealthEvent[];
  readonly window: TimeWindow;
}): Promise<HealthPatternInsightDraft> {
  if (!args.timelineSlice.length) throw new Error("Health pattern analysis requires a non-empty timeline slice.");

  const allowedIds = new Set<string>(args.timelineSlice.map((e) => e.id));
  const sanitizedSlice = args.timelineSlice.map(sanitizeAnyEvent);

  const { task, prompt } = buildHealthPatternInsightPrompt({
    timelineSlice: sanitizedSlice,
    window: args.window,
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

  const insightDraftRaw = obj["insightDraft"];
  if (!insightDraftRaw || typeof insightDraftRaw !== "object") throw new Error("Expected insightDraft object.");
  const idObj = insightDraftRaw as Record<string, unknown>;

  const title = idObj["title"];
  const summary = idObj["summary"];
  const hypothesesRaw = idObj["hypotheses"];

  if (typeof title !== "string" || !title.trim()) throw new Error("insightDraft.title must be a non-empty string.");
  if (typeof summary !== "string" || !summary.trim()) throw new Error("insightDraft.summary must be a non-empty string.");

  const hypotheses = asStringArray(Array.isArray(hypothesesRaw) ? hypothesesRaw : [], "insightDraft.hypotheses");

  const confidence = asConfidenceLevel(obj["confidence"]);
  const evidenceEventIds = asNonEmptyStringArray(obj["evidenceEventIds"], "evidenceEventIds");
  const uncertaintyNotes = asStringArray(obj["uncertaintyNotes"], "uncertaintyNotes");

  assertEvidenceSubset({ evidenceEventIds, allowedEventIds: allowedIds });

  return {
    DRAFT_AI_OUTPUT: true,
    taskName: "Health Pattern Insight",
    result: {
      insightDraft: {
        title: title.trim(),
        summary: summary.trim(),
        hypotheses,
      },
    },
    confidence,
    evidenceEventIds: evidenceEventIds as NonEmptyArray<string>,
    uncertaintyNotes,
  };
}
