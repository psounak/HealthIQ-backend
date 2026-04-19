import type { InsightEvent } from "../domain/InsightEvent";
import type { NonEmptyArray } from "../domain/HealthEvent";
import {
  asConfidenceLevel,
  asNonEmptyStringArray,
  asStringArray,
  assertEvidenceSubset,
  buildMedicalSpecializationSuggestionPrompt,
  callLLMAdapter,
  getDemoFallbackResponse,
  isDemoFallback,
  strictParseJsonObject,
  sanitizeInsightEvents,
  type DraftAIOutput,
  type SymptomLabelDraft,
} from "./PromptBuilders";

export type MedicalSpecializationSuggestionDraft = DraftAIOutput<
  "Medical Specialization Suggestion",
  {
    readonly specializations: readonly {
      readonly specialization: string;
      readonly reason: string;
      readonly evidenceEventIds: NonEmptyArray<string>;
    }[];
  }
>;

// REVIEW-FIRST POLICY:
// - Output MUST be reviewed before use.
// - Output MUST NOT be treated as diagnosis or urgency guidance.
// - Output MUST NOT be used to rank or prioritize providers.
export async function suggestMedicalSpecializations(args: {
  readonly symptomLabels: readonly SymptomLabelDraft[];
  readonly insights?: readonly InsightEvent[];
}): Promise<MedicalSpecializationSuggestionDraft> {
  if (!args.symptomLabels.length) throw new Error("Specialization suggestion requires at least one symptom label.");

  const allowedEvidenceIds = new Set<string>();
  for (const l of args.symptomLabels) for (const id of l.evidenceEventIds) allowedEvidenceIds.add(id);

  const { task, prompt } = buildMedicalSpecializationSuggestionPrompt({
    symptomLabels: args.symptomLabels,
    insights: args.insights ? sanitizeInsightEvents(args.insights) : [],
  });

  let raw: string;
  try {
    raw = await callLLMAdapter({ task, prompt });
  } catch {
    // Demo fallback: return deterministic, clearly-marked response when API is down.
    raw = getDemoFallbackResponse(task, [...allowedEvidenceIds]);
  }

  const parsed = strictParseJsonObject(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("LLM output must be a JSON object.");

  const obj = parsed as Record<string, unknown>;

  const specsRaw = obj["specializations"];
  if (!Array.isArray(specsRaw) || !specsRaw.length) throw new Error("Expected non-empty specializations array.");

  const specializations = specsRaw.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid specializations entry.");
    const it = item as Record<string, unknown>;

    const specialization = it["specialization"];
    const reason = it["reason"];
    if (typeof specialization !== "string" || !specialization.trim()) throw new Error("specialization must be a string.");
    if (typeof reason !== "string" || !reason.trim()) throw new Error("reason must be a string.");

    const evidenceEventIds = asNonEmptyStringArray(it["evidenceEventIds"], "specializations.evidenceEventIds");
    assertEvidenceSubset({ evidenceEventIds, allowedEventIds: allowedEvidenceIds });

    return {
      specialization: specialization.trim(),
      reason: reason.trim(),
      evidenceEventIds: evidenceEventIds as NonEmptyArray<string>,
    };
  });

  const confidence = asConfidenceLevel(obj["confidence"]);
  const uncertaintyNotes = asNonEmptyStringArray(obj["uncertaintyNotes"], "uncertaintyNotes");

  const unionEvidence: string[] = [];
  for (const s of specializations) unionEvidence.push(...s.evidenceEventIds);
  const evidenceEventIds = asNonEmptyStringArray(unionEvidence, "evidenceEventIds") as NonEmptyArray<string>;

  return {
    DRAFT_AI_OUTPUT: true,
    taskName: "Medical Specialization Suggestion",
    result: { specializations },
    confidence,
    evidenceEventIds,
    uncertaintyNotes,
  };
}
