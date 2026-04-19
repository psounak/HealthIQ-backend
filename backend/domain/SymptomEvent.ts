import type { HealthEvent, HealthEventType } from "./HealthEvent";

export interface SymptomEvent extends HealthEvent<HealthEventType.Symptom> {
  readonly eventType: HealthEventType.Symptom;

  readonly description: string;

  // Intentionally user-chosen and non-clinical (e.g., "mild", "7/10", "severe").
  readonly intensity?: string;

  // Context is user-reported (sleep, stress, possible triggers, environment).
  readonly userReportedContext?: string;
}
