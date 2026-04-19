import type { HealthEvent, HealthEventType } from "./HealthEvent";

export type MedicationAdherenceOutcome = "taken" | "missed" | "delayed";

export interface MedicationEvent extends HealthEvent<HealthEventType.Medication> {
  readonly eventType: HealthEventType.Medication;

  readonly name: string;
  readonly dosage: string;

  // Intentionally high-level (e.g., "once daily", "as needed").
  readonly intendedSchedule: string;

  readonly adherenceOutcome: MedicationAdherenceOutcome;
}
