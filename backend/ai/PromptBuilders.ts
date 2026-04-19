import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve as pathResolve } from "path";
import type {
  ConfidenceLevel,
  HealthEventType,
  ISODateTimeString,
  NonEmptyArray,
} from "../domain/HealthEvent";
import type { TimeWindow } from "../domain/HealthTimeline";
import type { ClinicalEvent } from "../domain/ClinicalEvent";
import type { InsightEvent } from "../domain/InsightEvent";
import type { LifestyleEvent } from "../domain/LifestyleEvent";
import type { MedicationEvent } from "../domain/MedicationEvent";
import type { SymptomEvent } from "../domain/SymptomEvent";

// This file builds deterministic, task-specific prompts from domain objects.
// It also provides the only way this backend layer should invoke the canonical LLM gateway: `llm_adapter.py`.
// No provider logic exists here; the adapter owns all provider routing.

// Load canonical task names from shared task_registry.json (single source of truth).
// Same file is consumed by llm_adapter.py — no string duplication.
function resolveProjectRoot(): string {
  const candidates = [
    pathResolve(__dirname, "..", ".."),
    pathResolve(__dirname, "..", "..", ".."),
    process.cwd(),
  ];

  for (const candidate of candidates) {
    if (existsSync(pathResolve(candidate, "task_registry.json")) && existsSync(pathResolve(candidate, "llm_adapter.py"))) {
      return candidate;
    }
  }

  return process.cwd();
}

const PROJECT_ROOT = resolveProjectRoot();

let _validTaskNames: ReadonlySet<string>;
try {
  const registryPath = pathResolve(PROJECT_ROOT, "task_registry.json");
  const raw = readFileSync(registryPath, "utf-8");
  const registry = JSON.parse(raw) as { strict_json_tasks?: string[] };
  _validTaskNames = new Set(registry.strict_json_tasks ?? []);
} catch {
  // Fallback: allow all TaskName values defined below.
  _validTaskNames = new Set<string>([
    "Symptom Interpretation",
    "Health Pattern Insight",
    "Medical Specialization Suggestion",
    "Doctor-Visit Summary",
  ]);
}

export type DraftAIOutput<TTaskName extends string, TResult> = Readonly<{
  DRAFT_AI_OUTPUT: true;
  taskName: TTaskName;

  // Task-specific payload.
  result: TResult;

  // Confidence is about output reliability, not medical certainty.
  confidence: ConfidenceLevel;

  // Evidence MUST reference HealthEvent ids from inputs.
  evidenceEventIds: NonEmptyArray<string>;

  // Required even if empty; callers should surface it during review.
  uncertaintyNotes: readonly string[];
}>;

export type TaskName =
  | "Symptom Interpretation"
  | "Health Pattern Insight"
  | "Medical Specialization Suggestion"
  | "Doctor-Visit Summary"
  | "Health Chat";

export interface SymptomLabelDraft {
  readonly label: string;
  readonly confidence: ConfidenceLevel;
  readonly evidenceEventIds: NonEmptyArray<string>;
}

export interface LLMAdapterCall {
  readonly task: TaskName;
  readonly prompt: string;

  // Optional adapter controls (only set with justification).
  readonly model_override?: string;
  readonly use_simulation?: boolean;
}

function stableJsonStringify(value: unknown): string {
  // Deterministic JSON: sorts object keys recursively.
  // This keeps prompts stable and makes caching more predictable.
  const seen = new WeakSet<object>();

  const normalize = (v: any): any => {
    if (v === null) return null;
    if (Array.isArray(v)) return v.map(normalize);
    if (typeof v !== "object") return v;

    if (seen.has(v)) {
      return "[CYCLE]";
    }
    seen.add(v);

    const keys = Object.keys(v).sort();
    const out: Record<string, any> = {};
    for (const k of keys) out[k] = normalize(v[k]);
    return out;
  };

  return JSON.stringify(normalize(value));
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
  // Intentionally strips:
  // - notes (often sensitive)
  // - metadata (extensible; easy to leak)
  // - tags (can contain identifiers)
  // - links (may imply causal claims)
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

export function sanitizeMedicationEvents(events: readonly MedicationEvent[]): readonly Record<string, unknown>[] {
  return events.map((e) => ({
    ...pickEventBaseForAI(e),
    name: e.name,
    dosage: e.dosage,
    intendedSchedule: e.intendedSchedule,
    adherenceOutcome: e.adherenceOutcome,
  }));
}

export function sanitizeSymptomEvents(events: readonly SymptomEvent[]): readonly Record<string, unknown>[] {
  return events.map((e) => ({
    ...pickEventBaseForAI(e),
    description: e.description,
    intensity: e.intensity,
    userReportedContext: e.userReportedContext,
  }));
}

export function sanitizeLifestyleEvents(events: readonly LifestyleEvent[]): readonly Record<string, unknown>[] {
  return events.map((e) => ({
    ...pickEventBaseForAI(e),
    sleep: e.sleep,
    stress: e.stress,
    activity: e.activity,
    food: e.food,
  }));
}

export function sanitizeClinicalEvents(events: readonly ClinicalEvent[]): readonly Record<string, unknown>[] {
  return events.map((e) => ({
    ...pickEventBaseForAI(e),
    doctorVisit: e.doctorVisit,
    diagnosisLabel: e.diagnosisLabel,
  }));
}

export function sanitizeInsightEvents(events: readonly InsightEvent[]): readonly Record<string, unknown>[] {
  // InsightEvent domain contract intentionally holds evidence links only.
  // Any human-reviewed insight text would live in `notes`, which is stripped here by design.
  return events.map((e) => ({
    ...pickEventBaseForAI(e),
    evidenceEventIds: e.evidenceEventIds,
  }));
}

function assertNonEmpty<T>(arr: readonly T[], name: string): asserts arr is readonly [T, ...T[]] {
  if (!arr.length) throw new Error(`Expected non-empty ${name}.`);
}

export function buildSymptomInterpretationPrompt(args: {
  readonly symptoms: readonly SymptomEvent[];
  readonly recentMedications?: readonly MedicationEvent[];
  readonly recentLifestyle?: readonly LifestyleEvent[];
}): { readonly task: "Symptom Interpretation"; readonly prompt: string } {
  assertNonEmpty(args.symptoms, "symptoms");

  const payload = {
    symptoms: sanitizeSymptomEvents(args.symptoms),
    recentMedications: args.recentMedications ? sanitizeMedicationEvents(args.recentMedications) : [],
    recentLifestyle: args.recentLifestyle ? sanitizeLifestyleEvents(args.recentLifestyle) : [],
  };

  // Task-specific prompt. Do not reuse for other tasks.
  const prompt =
    "TASK: Symptom Interpretation\n" +
    "ROLE: Convert user-reported symptoms into non-diagnostic labels for later review.\n" +
    "SAFETY RULES:\n" +
    "- NO DIAGNOSIS.\n" +
    "- NO disease probabilities.\n" +
    "- NO treatment advice.\n" +
    "OUTPUT RULES:\n" +
    "- Return ONLY valid JSON. No markdown. No extra keys beyond the schema.\n" +
    "- Evidence must reference provided event ids only.\n\n" +
    "INPUT (sanitized domain events):\n" +
    stableJsonStringify(payload) +
    "\n\n" +
    "RETURN JSON SCHEMA:\n" +
    "{\n" +
    "  \"symptomLabels\": [\n" +
    "    {\n" +
    "      \"label\": string,\n" +
    "      \"confidence\": \"low\"|\"medium\"|\"high\",\n" +
    "      \"evidenceEventIds\": [string, ...]\n" +
    "    }\n" +
    "  ],\n" +
    "  \"overallConfidence\": \"low\"|\"medium\"|\"high\",\n" +
    "  \"uncertaintyNotes\": [string, ...] | []\n" +
    "}";

  return { task: "Symptom Interpretation", prompt };
}

export function buildHealthPatternInsightPrompt(args: {
  readonly timelineSlice: readonly Record<string, unknown>[];
  readonly window: TimeWindow;
}): { readonly task: "Health Pattern Insight"; readonly prompt: string } {
  const payload = {
    window: args.window,
    timelineSlice: args.timelineSlice,
  };

  // Task-specific prompt. Do not reuse for other tasks.
  const prompt =
    "TASK: Health Pattern Insight\n" +
    "ROLE: Detect descriptive patterns within the provided time window.\n" +
    "SAFETY RULES:\n" +
    "- NO diagnosis.\n" +
    "- NO predictive medical claims.\n" +
    "- NO treatment advice.\n" +
    "OUTPUT RULES:\n" +
    "- Return ONLY valid JSON. No markdown.\n" +
    "- All claims must be evidence-linked to event ids.\n" +
    "- If pattern is weak, say so in uncertaintyNotes.\n\n" +
    "INPUT (time window + sanitized timeline events):\n" +
    stableJsonStringify(payload) +
    "\n\n" +
    "RETURN JSON SCHEMA:\n" +
    "{\n" +
    "  \"insightDraft\": {\n" +
    "    \"title\": string,\n" +
    "    \"summary\": string,\n" +
    "    \"hypotheses\": [string, ...] | []\n" +
    "  },\n" +
    "  \"confidence\": \"low\"|\"medium\"|\"high\",\n" +
    "  \"evidenceEventIds\": [string, ...],\n" +
    "  \"uncertaintyNotes\": [string, ...] | []\n" +
    "}";

  return { task: "Health Pattern Insight", prompt };
}

export function buildMedicalSpecializationSuggestionPrompt(args: {
  readonly symptomLabels: readonly SymptomLabelDraft[];
  readonly insights?: readonly Record<string, unknown>[];
}): { readonly task: "Medical Specialization Suggestion"; readonly prompt: string } {
  assertNonEmpty(args.symptomLabels, "symptomLabels");

  const payload = {
    symptomLabels: args.symptomLabels,
    insights: args.insights ?? [],
  };

  // Task-specific prompt. Do not reuse for other tasks.
  const prompt =
    "TASK: Medical Specialization Suggestion\n" +
    "ROLE: Suggest clinician specializations that may be relevant based on symptom labels.\n" +
    "SAFETY RULES:\n" +
    "- NO diagnosis.\n" +
    "- NO urgency grading.\n" +
    "- NO location-based guidance.\n" +
    "- NO doctor names.\n" +
    "OUTPUT RULES:\n" +
    "- Return ONLY valid JSON. No markdown.\n" +
    "- Reasons must reference symptom label evidence event ids.\n" +
    "- Must include an explicit uncertainty note.\n\n" +
    "INPUT (labels + optional sanitized insights):\n" +
    stableJsonStringify(payload) +
    "\n\n" +
    "RETURN JSON SCHEMA:\n" +
    "{\n" +
    "  \"specializations\": [\n" +
    "    {\n" +
    "      \"specialization\": string,\n" +
    "      \"reason\": string,\n" +
    "      \"evidenceEventIds\": [string, ...]\n" +
    "    }\n" +
    "  ],\n" +
    "  \"confidence\": \"low\"|\"medium\"|\"high\",\n" +
    "  \"uncertaintyNotes\": [string, ...]\n" +
    "}";

  return { task: "Medical Specialization Suggestion", prompt };
}

export function buildDoctorVisitSummaryPrompt(args: {
  readonly window: TimeWindow;
  readonly relevantEvents: readonly Record<string, unknown>[];
}): { readonly task: "Doctor-Visit Summary"; readonly prompt: string } {
  const payload = {
    window: args.window,
    relevantEvents: args.relevantEvents,
  };

  // Task-specific prompt. Do not reuse for other tasks.
  const prompt =
    "TASK: Doctor-Visit Summary\n" +
    "ROLE: Produce a neutral, factual, chronological summary for a clinician visit.\n" +
    "SAFETY RULES:\n" +
    "- NO advice.\n" +
    "- NO diagnosis.\n" +
    "- NO treatment recommendations.\n" +
    "OUTPUT RULES:\n" +
    "- Return ONLY valid JSON. No markdown.\n" +
    "- Preserve uncertainty; do not hide missing data.\n\n" +
    "INPUT (window + sanitized events):\n" +
    stableJsonStringify(payload) +
    "\n\n" +
    "RETURN JSON SCHEMA:\n" +
    "{\n" +
    "  \"summary\": string,\n" +
    "  \"includedEventIds\": [string, ...],\n" +
    "  \"confidence\": \"low\"|\"medium\"|\"high\",\n" +
    "  \"uncertaintyNotes\": [string, ...] | []\n" +
    "}";

  return { task: "Doctor-Visit Summary", prompt };
}

export function buildHealthChatPrompt(args: {
  readonly userMessage: string;
  readonly recentEvents: readonly Record<string, unknown>[];
}): { readonly task: "Health Chat"; readonly prompt: string } {
  const payload = {
    userMessage: args.userMessage,
    recentEvents: args.recentEvents,
  };

  const prompt =
    "TASK: Health Chat\n" +
    "ROLE: You are a friendly, knowledgeable health education assistant for HealthIQ.\n" +
    "You help users understand their health by providing educational, evidence-informed responses.\n\n" +

    "YOU ARE ENCOURAGED TO:\n" +
    "- Explain general health topics (e.g. what causes headaches, how sleep affects energy).\n" +
    "- Describe common symptoms and what they may generally indicate.\n" +
    "- Provide preventive health guidance and lifestyle suggestions.\n" +
    "- Offer condition overviews (e.g. general information about diabetes, hypertension).\n" +
    "- Discuss how lifestyle factors (sleep, stress, diet, exercise) affect health.\n" +
    "- Reference the user's timeline data to give personalized context when relevant.\n" +
    "- Explain medical terms in plain language.\n" +
    "- Be warm, supportive, and informative.\n\n" +

    "TONE & FRAMING:\n" +
    "- Use educational, neutral language.\n" +
    "- Frame information with uncertainty: use phrases like 'commonly associated with', " +
    "'may be related to', 'is often linked to', 'some people experience', 'research suggests'.\n" +
    "- Never claim certainty about a user's specific condition.\n" +
    "- Always maintain an informational, non-authoritative tone.\n\n" +

    "HARD BOUNDARIES (NEVER DO THESE):\n" +
    "- NEVER say 'You have [condition]' or 'You are diagnosed with [condition]'.\n" +
    "- NEVER prescribe medication or say 'Take [dose] of [medication]'.\n" +
    "- NEVER advise stopping or changing medication dosages.\n" +
    "- NEVER claim to replace a doctor or medical professional.\n" +
    "- NEVER state definitive medical conclusions (e.g. 'This is definitely...').\n" +
    "- NEVER provide emergency medical directives beyond advising to seek immediate care.\n\n" +

    "EMERGENCY HANDLING:\n" +
    "- If the user describes symptoms that could indicate an emergency (chest pain, difficulty breathing, " +
    "severe bleeding, sudden weakness, loss of consciousness, suicidal thoughts), respond with:\n" +
    "  1. A brief, calm acknowledgment.\n" +
    "  2. Clear advice to seek immediate medical attention or call emergency services.\n" +
    "  3. Do NOT attempt to diagnose the emergency.\n\n" +

    "DISCLAIMER FIELD:\n" +
    "- Always include the disclaimer field in your response.\n" +
    "- For health-related responses, use: 'While this information may help you understand your symptoms, " +
    "it is not a medical diagnosis. For personalized medical advice, please consult a qualified healthcare professional.'\n" +
    "- For non-health queries, use: 'HealthIQ provides general wellness information only.'\n\n" +

    "OUTPUT RULES:\n" +
    "- Return ONLY valid JSON. No markdown. No extra keys beyond the schema.\n\n" +
    "INPUT (user question + recent sanitized timeline events):\n" +
    stableJsonStringify(payload) +
    "\n\n" +
    "RETURN JSON SCHEMA:\n" +
    "{\n" +
    '  "reply": string,\n' +
    '  "disclaimer": string\n' +
    "}";

  return { task: "Health Chat", prompt };
}

export async function callLLMAdapter(call: LLMAdapterCall): Promise<string> {
  if (!call.task) throw new Error("LLM adapter call requires an explicit task name.");

  // Validate task name against shared registry to catch typos and drift at call time.
  if (!_validTaskNames.has(call.task)) {
    throw new Error(
      `Unknown task name "${call.task}". Valid tasks: ${[..._validTaskNames].join(", ")}. ` +
      `Update task_registry.json to add new tasks.`,
    );
  }

  const payload = {
    prompt: call.prompt,
    task: call.task,
    use_simulation: call.use_simulation ?? false,
    model_override: call.model_override,
  };

  // IMPORTANT:
  // - This is the ONLY gateway to LLM execution.
  // - Provider routing and key management live in the LLM service.
  // - This function refuses to run without an explicit task name.
  const LLM_TIMEOUT_MS = 30_000;

  // v2: Prefer HTTP gateway to persistent LLM service (eliminates process spawn overhead).
  // Falls back to child process spawning for backward compatibility.
  const llmServiceUrl = process.env.LLM_SERVICE_URL || "";

  if (llmServiceUrl) {
    // --- HTTP mode (v2) ---
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    try {
      const resp = await fetch(`${llmServiceUrl}/llm/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        throw new Error(`LLM service returned HTTP ${resp.status}: ${errBody}`);
      }

      const result = await resp.json() as { result: string };
      return result.result;
    } catch (err: any) {
      clearTimeout(timeout);
      if (err?.name === "AbortError") {
        throw new Error(`LLM service timed out after ${LLM_TIMEOUT_MS}ms (task: ${call.task}).`);
      }
      throw err;
    }
  }

  // --- Child process mode (v1 fallback) ---
  const pythonCode =
    "import sys, json\n" +
    "from llm_adapter import call_llm_router\n" +
    "payload = json.load(sys.stdin)\n" +
    "out = call_llm_router(**payload)\n" +
    "sys.stdout.write(out if isinstance(out, str) else str(out))\n";

  return await new Promise<string>((resolve, reject) => {
    let settled = false;

    const pythonBin = process.platform === "win32" ? "python" : "python3";
    const child = spawn(pythonBin, ["-c", pythonCode], {
      cwd: PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`LLM adapter timed out after ${LLM_TIMEOUT_MS}ms (task: ${call.task}).`));
      }
    }, LLM_TIMEOUT_MS);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      stdout += String(d);
    });

    child.stderr.on("data", (d) => {
      stderr += String(d);
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`llm_adapter.py failed (exit ${code}). ${stderr}`));
          return;
        }
        resolve(stdout.trim());
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export function strictParseJsonObject(raw: string): unknown {
  // Enforces "no free-form chat" by refusing non-JSON outputs.
  // Also detects structured error payloads from the LLM adapter (e.g., all providers failed).
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("LLM output was not valid JSON (rejected by contract).");
  }

  // Detect adapter-level error before normal task validation.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (obj["error"] === "all_providers_failed") {
      const detail = typeof obj["detail"] === "string" ? obj["detail"] : "unknown";
      throw new Error(`LLM adapter: all providers failed (${detail}). Retry or check API keys.`);
    }
  }

  return parsed;
}

export function asConfidenceLevel(value: unknown): ConfidenceLevel {
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new Error("Invalid confidence level in LLM output.");
}

export function asNonEmptyStringArray(value: unknown, label: string): NonEmptyArray<string> {
  if (!Array.isArray(value) || value.length < 1) throw new Error(`Expected non-empty string array for ${label}.`);
  for (const v of value) {
    if (typeof v !== "string" || !v.trim()) throw new Error(`Expected ${label} entries to be non-empty strings.`);
  }
  return value as unknown as NonEmptyArray<string>;
}

export function asStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`Expected string array for ${label}.`);
  for (const v of value) {
    if (typeof v !== "string") throw new Error(`Expected ${label} entries to be strings.`);
  }
  return value as readonly string[];
}

export function assertEvidenceSubset(args: {
  readonly evidenceEventIds: readonly string[];
  readonly allowedEventIds: ReadonlySet<string>;
}): void {
  for (const id of args.evidenceEventIds) {
    if (!args.allowedEventIds.has(id)) {
      throw new Error("LLM output referenced evidenceEventIds that were not provided in inputs.");
    }
  }
}

// Demo fallback: deterministic responses for when API providers are all down.
// Each response is clearly marked as DEMO_FALLBACK so UI can distinguish it from real AI output.
// These are structurally valid against each task's expected JSON schema.
const DEMO_FALLBACK_RESPONSES: Record<TaskName, string> = {
  "Symptom Interpretation": JSON.stringify({
    DEMO_FALLBACK: true,
    symptomLabels: [
      {
        label: "(Demo) Symptom label unavailable — API offline",
        confidence: "low",
        evidenceEventIds: ["__PLACEHOLDER__"],
      },
    ],
    overallConfidence: "low",
    uncertaintyNotes: ["This is a demo fallback response. Real AI analysis was unavailable."],
  }),
  "Health Pattern Insight": JSON.stringify({
    DEMO_FALLBACK: true,
    insightDraft: {
      title: "(Demo) Pattern analysis unavailable",
      summary: "AI providers were unreachable. This is a placeholder response for demo purposes.",
      hypotheses: [],
    },
    confidence: "low",
    evidenceEventIds: ["__PLACEHOLDER__"],
    uncertaintyNotes: ["This is a demo fallback response. Real AI analysis was unavailable."],
  }),
  "Medical Specialization Suggestion": JSON.stringify({
    DEMO_FALLBACK: true,
    specializations: [
      {
        specialization: "(Demo) General Practitioner",
        reason: "Fallback suggestion — AI providers were unreachable.",
        evidenceEventIds: ["__PLACEHOLDER__"],
      },
    ],
    confidence: "low",
    uncertaintyNotes: ["This is a demo fallback response. Real AI analysis was unavailable."],
  }),
  "Doctor-Visit Summary": JSON.stringify({
    DEMO_FALLBACK: true,
    summary: "(Demo) Visit summary unavailable — AI providers were unreachable during this request.",
    includedEventIds: ["__PLACEHOLDER__"],
    confidence: "low",
    uncertaintyNotes: ["This is a demo fallback response. Real AI analysis was unavailable."],
  }),
  "Health Chat": JSON.stringify({
    DEMO_FALLBACK: true,
    reply: "(Demo) Health chat is currently unavailable — AI providers are offline. Please try again later.",
    disclaimer: "This is a demo fallback response. HealthIQ is not a medical authority.",
  }),
};

export function getDemoFallbackResponse(taskName: TaskName, eventIds: readonly string[]): string {
  // Returns a structurally valid fallback response with real event IDs substituted in.
  const template = DEMO_FALLBACK_RESPONSES[taskName];
  const firstId = eventIds.length > 0 ? eventIds[0] : "no-events";
  return template.replace(/"__PLACEHOLDER__"/g, JSON.stringify(firstId));
}

export function isDemoFallback(parsed: unknown): boolean {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return (parsed as Record<string, unknown>)["DEMO_FALLBACK"] === true;
  }
  return false;
}
