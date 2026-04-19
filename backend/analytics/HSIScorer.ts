import type { AnyHealthEvent } from "../domain/HealthTimeline";
import type { SymptomEvent } from "../domain/SymptomEvent";
import type { MedicationEvent } from "../domain/MedicationEvent";
import type { LifestyleEvent } from "../domain/LifestyleEvent";
import { HealthEventType } from "../domain/HealthEvent";

// =========================================================================
// HealthIQ v2 — Health Stability Index (HSI) Scoring Engine
//
// Composite score (0–100) representing health trajectory stability.
// Three sub-dimensions:
//   1. Symptom Regularity (40%) — variance in symptom frequency/severity
//   2. Behavioral Consistency (30%) — medication adherence + lifestyle regularity
//   3. Trajectory Direction (30%) — is symptom burden improving or worsening?
//
// DETERMINISTIC: No LLM required. Pure TypeScript computation.
// STATELESS: Client sends events, server computes and returns. No DB.
// =========================================================================

export interface HSIScore {
  score: number;                      // 0–100
  symptomRegularity: number;          // 0–100
  behavioralConsistency: number;      // 0–100
  trajectoryDirection: number;        // 0–100
  windowDays: number;
  dataConfidence: "low" | "medium" | "high";
  contributingEventIds: string[];
  computedAt: string;                 // ISO timestamp
}

// --- Utility ---

function daysBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24);
}

function isoToDate(iso: string): Date {
  return new Date(iso);
}

function groupByDay(events: readonly { timestamp: { absolute: string } }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of events) {
    const day = e.timestamp.absolute.substring(0, 10); // YYYY-MM-DD
    map.set(day, (map.get(day) || 0) + 1);
  }
  return map;
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function linearRegressionSlope(values: number[]): number {
  if (values.length < 2) return 0;
  const n = values.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function parseIntensity(intensity: string | undefined): number | null {
  if (!intensity) return null;
  const fracMatch = intensity.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+)/);
  if (fracMatch) return (parseFloat(fracMatch[1]) / parseFloat(fracMatch[2])) * 10;
  const numMatch = intensity.match(/^(\d+(?:\.\d+)?)/);
  if (numMatch) return parseFloat(numMatch[1]);
  const lower = intensity.toLowerCase().trim();
  const keywordMap: Record<string, number> = {
    mild: 3, slight: 2, moderate: 5, severe: 8, extreme: 10,
    low: 2, medium: 5, high: 8, very: 7, terrible: 9, awful: 9,
  };
  for (const [kw, val] of Object.entries(keywordMap)) {
    if (lower.includes(kw)) return val;
  }
  return null;
}

// =========================================================================
// Sub-scores
// =========================================================================

export function computeSymptomRegularity(
  symptoms: readonly SymptomEvent[],
  windowDays: number,
): number {
  if (symptoms.length < 3) return 60;
  const dailyCounts = groupByDay(symptoms);
  const countValues = Array.from(dailyCounts.values());
  const cv = coefficientOfVariation(countValues);
  const cvScore = Math.max(10, Math.min(95, 90 - cv * 50));

  const intensities: number[] = [];
  for (const s of symptoms) {
    const val = parseIntensity(s.intensity);
    if (val !== null) intensities.push(val);
  }
  let intensityScore = 70;
  if (intensities.length >= 3) {
    const intensityCV = coefficientOfVariation(intensities);
    intensityScore = Math.max(10, Math.min(95, 85 - intensityCV * 40));
  }

  const uniqueDescriptions = new Set(symptoms.map((s) => s.description.toLowerCase().trim()));
  const diversityPenalty = Math.max(0, (uniqueDescriptions.size - 5) * 3);
  return Math.round(Math.max(5, (cvScore * 0.5 + intensityScore * 0.5) - diversityPenalty));
}

export function computeBehavioralConsistency(
  medications: readonly MedicationEvent[],
  lifestyle: readonly LifestyleEvent[],
  windowDays: number,
): number {
  let adherenceScore = 70;
  if (medications.length >= 3) {
    const taken = medications.filter((m) => m.adherenceOutcome === "taken").length;
    adherenceScore = Math.round((taken / medications.length) * 100);
  }
  const lifestyleDays = groupByDay(lifestyle);
  const coverageRatio = Math.min(1, lifestyleDays.size / Math.max(1, windowDays));
  const lifestyleScore = Math.round(coverageRatio * 100);
  return Math.round(adherenceScore * 0.6 + lifestyleScore * 0.4);
}

export function computeTrajectoryDirection(
  symptoms: readonly SymptomEvent[],
  windowDays: number,
): number {
  if (symptoms.length < 5) return 55;
  const dailyBurden = new Map<string, { count: number; totalIntensity: number }>();
  for (const s of symptoms) {
    const day = s.timestamp.absolute.substring(0, 10);
    const existing = dailyBurden.get(day) || { count: 0, totalIntensity: 0 };
    existing.count += 1;
    const intensity = parseIntensity(s.intensity);
    existing.totalIntensity += intensity !== null ? intensity : 5;
    dailyBurden.set(day, existing);
  }
  const sortedDays = Array.from(dailyBurden.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([_, v]) => v.count * (v.totalIntensity / v.count));
  const slope = linearRegressionSlope(sortedDays);
  const slopeScore = Math.max(10, Math.min(95, 60 - slope * 60));
  return Math.round(slopeScore);
}

// =========================================================================
// Main HSI Computation
// =========================================================================

export function computeHSI(
  events: readonly AnyHealthEvent[],
  windowDays: number = 30,
): HSIScore {
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const windowEvents = events.filter((e) => {
    const eventDate = isoToDate(e.timestamp.absolute);
    return eventDate >= windowStart && eventDate <= now;
  });

  const symptomEvents = windowEvents.filter(
    (e): e is SymptomEvent => e.eventType === HealthEventType.Symptom,
  );
  const medicationEvents = windowEvents.filter(
    (e): e is MedicationEvent => e.eventType === HealthEventType.Medication,
  );
  const lifestyleEvents = windowEvents.filter(
    (e): e is LifestyleEvent => e.eventType === HealthEventType.Lifestyle,
  );

  const symptomRegularity = computeSymptomRegularity(symptomEvents, windowDays);
  const behavioralConsistency = computeBehavioralConsistency(medicationEvents, lifestyleEvents, windowDays);
  const trajectoryDirection = computeTrajectoryDirection(symptomEvents, windowDays);

  const score = Math.round(
    symptomRegularity * 0.4 +
    behavioralConsistency * 0.3 +
    trajectoryDirection * 0.3,
  );

  const eventTypes = new Set(windowEvents.map((e) => e.eventType));
  const dataSpanDays = windowEvents.length > 1
    ? daysBetween(
        isoToDate(windowEvents[0].timestamp.absolute),
        isoToDate(windowEvents[windowEvents.length - 1].timestamp.absolute),
      )
    : 0;

  let dataConfidence: "low" | "medium" | "high" = "low";
  if (windowEvents.length >= 30 && eventTypes.size >= 3 && dataSpanDays >= 21) {
    dataConfidence = "high";
  } else if (windowEvents.length >= 15 && eventTypes.size >= 2 && dataSpanDays >= 14) {
    dataConfidence = "medium";
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    symptomRegularity,
    behavioralConsistency,
    trajectoryDirection,
    windowDays,
    dataConfidence,
    contributingEventIds: windowEvents.map((e) => e.id),
    computedAt: now.toISOString(),
  };
}
