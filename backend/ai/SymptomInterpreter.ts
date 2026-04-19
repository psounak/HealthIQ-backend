import type { LifestyleEvent } from "../domain/LifestyleEvent";
import type { MedicationEvent } from "../domain/MedicationEvent";
import type { SymptomEvent } from "../domain/SymptomEvent";
import type { NonEmptyArray } from "../domain/HealthEvent";
import {
  asConfidenceLevel,
  asNonEmptyStringArray,
  asStringArray,
  assertEvidenceSubset,
  buildSymptomInterpretationPrompt,
  callLLMAdapter,
  getDemoFallbackResponse,
  isDemoFallback,
  strictParseJsonObject,
  type DraftAIOutput,
  type SymptomLabelDraft,
} from "./PromptBuilders";

export type SymptomInterpretationDraft = DraftAIOutput<
  "Symptom Interpretation",
  {
    readonly symptomLabels: readonly SymptomLabelDraft[];
  }
>;

// REVIEW-FIRST POLICY:
// - This output MUST be reviewed before saving.
// - This output MUST NOT be auto-applied to the timeline.
// - This output can be rejected or contested by the user.
//
// Boundaries enforced here:
// - Accepts only domain events (no raw strings).
// - Requires JSON-only LLM output.
// - Requires evidenceEventIds that reference provided event ids.
export async function interpretSymptoms(args: {
  readonly symptoms: readonly SymptomEvent[];
  readonly recentMedications?: readonly MedicationEvent[];
  readonly recentLifestyle?: readonly LifestyleEvent[];
}): Promise<SymptomInterpretationDraft> {
  const { task, prompt } = buildSymptomInterpretationPrompt(args);

  const allEventIds = [
    ...args.symptoms.map((e) => e.id),
    ...(args.recentMedications ?? []).map((e) => e.id),
    ...(args.recentLifestyle ?? []).map((e) => e.id),
  ];

  let raw: string;
  try {
    raw = await callLLMAdapter({ task, prompt });
  } catch {
    // Demo fallback: return deterministic, clearly-marked response when API is down.
    raw = getDemoFallbackResponse(task, allEventIds);
  }

  const parsed = strictParseJsonObject(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("LLM output must be a JSON object.");

  const obj = parsed as Record<string, unknown>;

  const symptomLabelsRaw = obj["symptomLabels"];
  if (!Array.isArray(symptomLabelsRaw)) throw new Error("Expected symptomLabels array.");

  const allowedIds = new Set<string>();
  for (const e of args.symptoms) allowedIds.add(e.id);
  for (const e of args.recentMedications ?? []) allowedIds.add(e.id);
  for (const e of args.recentLifestyle ?? []) allowedIds.add(e.id);

  const symptomLabels: SymptomLabelDraft[] = symptomLabelsRaw.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid symptomLabels entry.");
    const it = item as Record<string, unknown>;

    const label = it["label"];
    if (typeof label !== "string" || !label.trim()) throw new Error("Symptom label must be a non-empty string.");

    const confidence = asConfidenceLevel(it["confidence"]);
    const evidenceEventIds = asNonEmptyStringArray(it["evidenceEventIds"], "symptomLabels.evidenceEventIds");

    assertEvidenceSubset({ evidenceEventIds, allowedEventIds: allowedIds });

    return {
      label: label.trim(),
      confidence,
      evidenceEventIds,
    };
  });

  if (!symptomLabels.length) throw new Error("LLM output contained no symptom labels.");

  const overallConfidence = asConfidenceLevel(obj["overallConfidence"]);
  const uncertaintyNotes = asStringArray(obj["uncertaintyNotes"], "uncertaintyNotes");

  // Union evidence across labels.
  const union: string[] = [];
  for (const l of symptomLabels) union.push(...l.evidenceEventIds);
  const evidenceEventIds = asNonEmptyStringArray(union, "evidenceEventIds") as NonEmptyArray<string>;

  return {
    DRAFT_AI_OUTPUT: true,
    taskName: "Symptom Interpretation",
    result: { symptomLabels },
    confidence: overallConfidence,
    evidenceEventIds,
    uncertaintyNotes,
  };
}
